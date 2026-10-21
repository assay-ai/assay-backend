import { Logger } from '@nestjs/common';
import { LookupAddress, lookup as dnsLookup } from 'node:dns';
import { promisify } from 'node:util';

import { isIP } from 'node:net';

import { isDeniedHost } from './denied-hosts';
import { EgressError, EgressFailureKind } from './egress.errors';
import { EgressPolicy, EgressTrust } from './egress.policy';
import { classifyAddress, isBlockedVerdict } from './ip-rules';

const lookupAll = promisify(dnsLookup) as (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

const logger = new Logger('EgressGuard');

/** The DNS surface this module needs, so a test can supply an answer. */
export type EgressDnsLookup = (hostname: string) => Promise<LookupAddress[]>;

const defaultLookup: EgressDnsLookup = (hostname) =>
  lookupAll(hostname, { all: true, verbatim: true });

/**
 * A destination that has been checked and is now **pinned**.
 *
 * `address` is the single answer we will connect to. It is passed back into
 * `http.request` as a fixed `lookup`, which is the entire anti-rebinding
 * mechanism: the name is resolved once, here, and the socket is opened to the
 * bytes this object carries. A second DNS answer arriving between this check
 * and the connect has nothing to attach itself to.
 */
export interface EgressTarget {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: number;
}

const DEFAULT_PORT: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 };

/** How long a checked answer may stand in for a lookup that failed transiently. */
export const LAST_GOOD_DNS_MAX_AGE_MS = 10 * 60 * 1000;

/** The pause before the one retry of a transient lookup failure. */
export const DNS_RETRY_DELAY_MS = 100;

/**
 * Lookup errors that say "the resolver could not answer now", not "the name
 * has no address": a timeout, `EAI_AGAIN` (what getaddrinfo reports on Linux
 * when the resolver is unreachable) and SERVFAIL.
 *
 * **`ENOTFOUND` is deliberately not here** (review M-1). It is NXDOMAIN, and
 * a name that was deleted, or a domain that lapsed, must stop receiving calls
 * — with the binding's credential headers — at once, not keep its old address
 * for ten minutes in case the IP has been reassigned. The cost: on macOS,
 * whose resolver also answers `ENOTFOUND` when it cannot be reached (the e2e
 * run of BUG-X-04), the fallback does not apply.
 */
const TRANSIENT_DNS_CODES: ReadonlySet<string> = new Set([
  'EAI_AGAIN',
  'ESERVFAIL',
  'ETIMEOUT',
  'ETIMEDOUT',
]);

function isTransientDnsFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_DNS_CODES.has(code);
}

/**
 * The last answer per host that **passed the address check**, for a lookup
 * that fails transiently (BUG-X-04).
 *
 * Not a DNS cache: every call still resolves, and a fresh answer always wins.
 * Only when the lookup failed transiently twice is the last stored answer
 * used, and only within {@link LAST_GOOD_DNS_MAX_AGE_MS} of when it was
 * resolved. Entries are keyed by host AND trust level, are written only after
 * the answer passed that policy's address check, and are checked again on
 * reuse — so a cached answer can never let a request reach an address its own
 * policy refuses, and nothing new (let alone a new private address) is ever
 * accepted through it. Pinning and relaying are unchanged: the reused address
 * is what the socket (or the relay) is given, exactly as a fresh one would be.
 */
export class LastGoodDnsAnswers {
  private readonly entries = new Map<
    string,
    { readonly records: readonly LookupAddress[]; readonly at: number }
  >();

  constructor(
    private readonly maxAgeMs: number = LAST_GOOD_DNS_MAX_AGE_MS,
    private readonly now: () => number = () => Date.now(),
    // Each success re-inserts its host at the newest end, so a host in use
    // is not pushed out by a burst of others; the cap only bounds memory.
    private readonly maxEntries = 5000,
  ) {}

  remember(key: string, records: readonly LookupAddress[]): void {
    this.entries.delete(key);
    this.entries.set(key, { records: records.map((r) => ({ ...r })), at: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  /** The stored answer and its age, or `null` when there is none young enough. */
  recall(key: string): { records: LookupAddress[]; ageMs: number } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const ageMs = this.now() - entry.at;
    if (ageMs < 0 || ageMs > this.maxAgeMs) {
      this.entries.delete(key);
      return null;
    }
    return { records: entry.records.map((r) => ({ ...r })), ageMs };
  }
}

/**
 * Parse, check the scheme, resolve once, and check every answer.
 *
 * Two decisions in here are stricter than they strictly have to be, both
 * deliberately:
 *
 * 1. **Every** returned record must pass, not just the one we pick. A hostname
 *    that answers with one public and one private address is not a host with a
 *    dual homing story — it is a rebinding attempt betting on which record we
 *    take. Refusing the whole name costs us nothing real and removes the bet.
 * 2. An IP **literal** in the URL is checked directly and never handed to the
 *    resolver. `dns.lookup` does pass a literal straight back, so routing it
 *    through DNS would usually work — but "usually" is doing load-bearing work
 *    there, and the behaviour belongs to a resolver we do not control. The
 *    check for `http://169.254.169.254/latest/meta-data/` must not depend on
 *    what `/etc/nsswitch.conf` says.
 */
export async function resolveEgressTarget(
  rawUrl: string,
  policy: EgressPolicy,
  lookup: EgressDnsLookup = defaultLookup,
  lastGood?: LastGoodDnsAnswers,
): Promise<EgressTarget> {
  const url = parseUrl(rawUrl);

  if (!policy.allowedProtocols.includes(url.protocol)) {
    throw new EgressError(
      EgressFailureKind.SCHEME_NOT_ALLOWED,
      `scheme "${url.protocol}" is not one of ${policy.allowedProtocols.join(', ')}`,
      { url: rawUrl },
    );
  }

  const hostname = stripBrackets(url.hostname);
  if (hostname.length === 0) {
    throw new EgressError(EgressFailureKind.URL_INVALID, 'URL has no host', { url: rawUrl });
  }

  // Before any lookup: naming one of our own hosts is refused whatever it
  // resolves to, and resolving it would only add a query to our own zone.
  if (isDeniedHost(hostname)) {
    throw new EgressError(EgressFailureKind.BLOCKED_ADDRESS, "the host is one of Assay's own", {
      url: url.href,
    });
  }

  const cacheKey = `${policy.trust}|${hostname.toLowerCase()}`;
  const resolved = isIP(hostname)
    ? { records: [literal(hostname)], fresh: false }
    : await resolve(hostname, url.href, lookup, lastGood?.recall.bind(lastGood, cacheKey));
  const records = resolved.records;

  if (policy.trust === EgressTrust.PUBLIC_ONLY) {
    for (const record of records) {
      const verdict = classifyAddress(record.address);
      if (isBlockedVerdict(verdict)) {
        // The address and the range stay in the log. The message reaches the
        // provider who typed the URL (connectivity check, mapping tester), and
        // naming the private address an internal name resolves to turns the
        // guard into a map of the cluster.
        logger.warn(`Refused ${hostname}: resolves to ${record.address} — ${verdict.detail}`);
        throw new EgressError(
          EgressFailureKind.BLOCKED_ADDRESS,
          'the host resolves to a non-public address',
          { url: url.href, address: record.address, addressReason: verdict.reason },
        );
      }
    }
  }

  // Only an answer that has just passed the check above is kept for a later
  // transient failure (never a literal, never a reused one re-stored).
  if (resolved.fresh && lastGood) lastGood.remember(cacheKey, records);

  const chosen = records[0];

  return {
    url,
    address: chosen.address,
    family: chosen.family === 6 ? 6 : 4,
    port: url.port ? Number(url.port) : DEFAULT_PORT[url.protocol],
  };
}

/** An address the URL already stated. No resolver is consulted. */
function literal(hostname: string): LookupAddress {
  return { address: hostname, family: isIP(hostname) };
}

function parseUrl(rawUrl: string): URL {
  try {
    return new URL(rawUrl);
  } catch (error) {
    throw new EgressError(EgressFailureKind.URL_INVALID, 'not a parseable absolute URL', {
      url: rawUrl,
      cause: error,
    });
  }
}

/** `URL.hostname` keeps the brackets on an IPv6 literal; the resolver must not see them. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

async function resolve(
  hostname: string,
  href: string,
  lookup: EgressDnsLookup,
  recallLastGood?: () => { records: LookupAddress[]; ageMs: number } | null,
): Promise<{ records: LookupAddress[]; fresh: boolean }> {
  let records: LookupAddress[];

  try {
    records = await lookupWithOneRetry(hostname, lookup);
  } catch (error) {
    // Two transient failures in a row: the last answer that passed the check,
    // if it is recent enough. Anything else (a refusal the caller injected, a
    // resolver error that is not transient) fails as before.
    const lastGood = isTransientDnsFailure(error) ? recallLastGood?.() : null;
    if (lastGood) {
      logger.warn(
        `${hostname} did not resolve (${(error as { code?: string }).code}); using its last ` +
          `checked answer from ${Math.round(lastGood.ageMs / 1000)}s ago`,
      );
      return { records: lastGood.records, fresh: false };
    }
    throw new EgressError(
      EgressFailureKind.DNS_FAILED,
      `${hostname} did not resolve: ${error instanceof Error ? error.message : String(error)}`,
      { url: href, cause: error },
    );
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new EgressError(EgressFailureKind.DNS_FAILED, `${hostname} resolved to no addresses`, {
      url: href,
    });
  }

  return { records, fresh: true };
}

/** One lookup, and one more after {@link DNS_RETRY_DELAY_MS} when the first failed transiently. */
async function lookupWithOneRetry(
  hostname: string,
  lookup: EgressDnsLookup,
): Promise<LookupAddress[]> {
  try {
    return await lookup(hostname);
  } catch (error) {
    if (!isTransientDnsFailure(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, DNS_RETRY_DELAY_MS));
    return lookup(hostname);
  }
}
