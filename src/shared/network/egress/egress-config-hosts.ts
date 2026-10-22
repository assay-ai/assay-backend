import { isIP } from 'node:net';

/**
 * Hosts named by **server configuration** — the operator's own chain RPC
 * nodes, the facilitator and Kora — as opposed to hosts a provider, a buyer
 * or any other third party typed (BUG-X-04, trust tiers).
 *
 * The list is read from the environment once, at boot, and nothing a request
 * carries can add to it. It only widens one thing: when such a host's lookup
 * fails with `ENOTFOUND`, an `INTERNAL_ALLOWED` call (hop 0 only) may still
 * use the last answer that passed the address check, within the usual
 * 10 minutes (see `resolve-target.ts`). The address check, pinning and the
 * relay rules are unchanged.
 */
export const EGRESS_CONFIG_HOSTS = Symbol('EGRESS_CONFIG_HOSTS');

/** Variables holding one URL each that the server dials through the egress client. */
export const CONFIG_ORIGIN_URL_ENVS: readonly string[] = Object.freeze([
  'FACILITATOR_URL',
  'KORA_RPC_URL',
]);

/** Variables holding a JSON object of URLs (`{"eip155:…": "https://…"}`). */
export const CONFIG_ORIGIN_URL_MAP_ENVS: readonly string[] = Object.freeze(['EVM_RPC_URLS']);

/**
 * The host names of every configured URL, lower-cased.
 *
 * Lenient on purpose: the modules that own each variable validate it and fail
 * the boot themselves. A value that does not parse simply adds no host, which
 * keeps that host on the strict tier. IP literals are left out: they are never
 * resolved, so there is nothing to reuse. `localhost` and `*.localhost` are
 * left out too.
 */
export function configOriginEgressHosts(
  read: (name: string) => string | undefined,
): ReadonlySet<string> {
  const urls: string[] = [];

  for (const name of CONFIG_ORIGIN_URL_ENVS) {
    const value = read(name)?.trim();
    if (value) urls.push(value);
  }

  for (const name of CONFIG_ORIGIN_URL_MAP_ENVS) {
    const raw = read(name)?.trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    for (const value of Object.values(parsed)) {
      if (typeof value === 'string' && value.trim()) urls.push(value.trim());
    }
  }

  const hosts = new Set<string>();
  for (const raw of urls) {
    const host = hostOf(raw);
    if (host) hosts.add(host);
  }
  return hosts;
}

function hostOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host.length === 0 || isIP(host) !== 0) return null;
  // Loopback names are never on the config tier (review M-2): the e2e-only
  // loopback CIMD fetch is INTERNAL_ALLOWED too, and a stranger picks its URL.
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  return host;
}
