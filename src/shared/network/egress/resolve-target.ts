import { LookupAddress, lookup as dnsLookup } from 'node:dns';
import { promisify } from 'node:util';

import { isIP } from 'node:net';

import { EgressError, EgressFailureKind } from './egress.errors';
import { EgressPolicy, EgressTrust } from './egress.policy';
import { classifyAddress, isBlockedVerdict } from './ip-rules';

const lookupAll = promisify(dnsLookup) as (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

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

  const records = isIP(hostname) ? [literal(hostname)] : await resolve(hostname, url.href, lookup);

  if (policy.trust === EgressTrust.PUBLIC_ONLY) {
    for (const record of records) {
      const verdict = classifyAddress(record.address);
      if (isBlockedVerdict(verdict)) {
        throw new EgressError(
          EgressFailureKind.BLOCKED_ADDRESS,
          `${hostname} resolves to ${record.address} — ${verdict.detail}`,
          { url: url.href, address: record.address, addressReason: verdict.reason },
        );
      }
    }
  }

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
): Promise<LookupAddress[]> {
  let records: LookupAddress[];

  try {
    records = await lookup(hostname);
  } catch (error) {
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

  return records;
}
