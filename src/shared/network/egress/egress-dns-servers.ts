import { LookupAddress } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

import { EgressDnsLookup, systemEgressLookup } from './resolve-target';

/**
 * `DNS_SERVERS` (optional): the name servers the egress lookup asks, instead
 * of the host's system resolver (BUG-X-04).
 *
 * A comma-separated list of IP addresses, each with an optional port:
 * `1.1.1.1, 8.8.8.8:53, [2606:4700:4700::1111]:53`. Host names are refused —
 * resolving the resolver would need the resolver.
 *
 * Only *where the answer comes from* changes. The answer then goes through the
 * same address check, pinning, last-good rules and relay rules as a system
 * answer. With the variable set, `/etc/hosts` and search domains are not used,
 * except for `localhost` and `*.localhost`, which keep the system lookup.
 */
export const DNS_SERVERS_ENV = 'DNS_SERVERS';

/** Per query attempt, and how many attempts per server (c-ares options). */
export const DNS_SERVERS_TIMEOUT_MS = 2_000;
export const DNS_SERVERS_TRIES = 2;

/**
 * Parse `DNS_SERVERS`. `null` when unset or blank (system resolver). Throws a
 * message that names the variable when an entry is not an IP address.
 */
export function parseDnsServers(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const entries = raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    if (!isServerEntry(entry)) {
      throw new Error(
        `${DNS_SERVERS_ENV} must be a comma-separated list of IP addresses (optional :port)`,
      );
    }
  }
  return entries;
}

function isServerEntry(entry: string): boolean {
  if (isIP(entry) !== 0) return true;
  const v6 = /^\[([^\]]+)\]:(\d{1,5})$/.exec(entry);
  if (v6) return isIP(v6[1]) === 6 && validPort(v6[2]);
  const v4 = /^([^:]+):(\d{1,5})$/.exec(entry);
  if (v4) return isIP(v4[1]) === 4 && validPort(v4[2]);
  return false;
}

function validPort(raw: string): boolean {
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** The pieces of `dns/promises.Resolver` this lookup uses, so a test can supply them. */
export interface DnsServersResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

/** Codes that mean "this name has no such record", not "the server did not answer". */
const NO_RECORD_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * An egress lookup that asks `servers` directly (A and AAAA in parallel).
 *
 * The errors are shaped like `dns.lookup`'s, so the transient/strict rules in
 * `resolve-target.ts` read them the same way:
 *
 * - no A and no AAAA record, or NXDOMAIN → `ENOTFOUND` (what getaddrinfo says);
 * - a server that could not be reached (`ECONNREFUSED`) → `EAI_AGAIN`, the
 *   code getaddrinfo uses for an unreachable resolver;
 * - `ETIMEOUT`, `ESERVFAIL` and any other code pass through unchanged.
 *
 * When one family answers and the other fails, the answer that came back is
 * used; every record of it is still checked.
 */
export function dnsServersLookup(
  servers: readonly string[],
  options: {
    resolver?: DnsServersResolver;
    systemLookup?: EgressDnsLookup;
  } = {},
): EgressDnsLookup {
  const resolver = options.resolver ?? systemResolver(servers);
  const systemLookup = options.systemLookup ?? systemEgressLookup;

  return async (hostname: string): Promise<LookupAddress[]> => {
    const name = hostname.toLowerCase();
    if (name === 'localhost' || name.endsWith('.localhost')) {
      return systemLookup(hostname);
    }

    const [v4, v6] = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);

    const records: LookupAddress[] = [
      ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []),
      ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : []),
    ];
    if (records.length > 0) return records;

    const errors = [v4, v6]
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason as NodeJS.ErrnoException);
    const serverFailure = errors.find((e) => !NO_RECORD_CODES.has(String(e?.code)));
    if (serverFailure) {
      throw serverFailure.code === 'ECONNREFUSED'
        ? dnsError('EAI_AGAIN', hostname, serverFailure)
        : serverFailure;
    }
    throw dnsError('ENOTFOUND', hostname, errors[0]);
  };
}

function systemResolver(servers: readonly string[]): DnsServersResolver {
  const resolver = new Resolver({ timeout: DNS_SERVERS_TIMEOUT_MS, tries: DNS_SERVERS_TRIES });
  resolver.setServers([...servers]);
  return resolver;
}

function dnsError(code: string, hostname: string, cause?: unknown): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException & { cause?: unknown } = new Error(
    `queryA/AAAA ${code} ${hostname}`,
  );
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}
