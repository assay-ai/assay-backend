/**
 * Assay's own domains, which no outbound call may target.
 *
 * Provider endpoints and client metadata URLs are chosen by third parties. One
 * that names `api.goassay.ai` (or any other host of ours) would make this
 * server, or the egress relay on its behalf, call back into our own origin from
 * inside Cloudflare — past the zone's WAF, rate limits and Access rules, and
 * with whatever trust a request from our own Worker carries. Nothing Assay
 * does needs that, so the hosts are refused outright, at Save and on every hop.
 *
 * `EGRESS_DENIED_HOST_SUFFIXES` (comma-separated, default `goassay.ai`) names
 * the registrable domains: each one and every subdomain of it is refused.
 * Keep it equal to `DENIED_HOST_SUFFIXES` in `workers/egress-relay/wrangler.toml`.
 */
export const EGRESS_DENIED_HOST_SUFFIXES_ENV = 'EGRESS_DENIED_HOST_SUFFIXES';

const DEFAULT_DENIED_HOST_SUFFIXES: readonly string[] = Object.freeze(['goassay.ai']);

/** Lower case, no trailing dot, no surrounding dots: the form both sides are compared in. */
function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
}

/** The configured suffixes; the default when the variable is unset or empty. */
export function deniedHostSuffixes(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const configured = (env[EGRESS_DENIED_HOST_SUFFIXES_ENV] ?? '')
    .split(',')
    .map(normalizeHost)
    .filter((suffix) => suffix.length > 0);
  return configured.length > 0 ? configured : DEFAULT_DENIED_HOST_SUFFIXES;
}

/**
 * Whether `hostname` is one of Assay's own hosts.
 *
 * Expects `URL.hostname`, which is already lower case and punycode for an
 * internationalised name, so a Unicode look-alike is compared in the same form
 * as the suffix. The match is on a label boundary: `goassay.ai` and
 * `api.goassay.ai` are refused, `notgoassay.ai` and `goassay.ai.example.com`
 * are not.
 */
export function isDeniedHost(
  hostname: string,
  suffixes: readonly string[] = deniedHostSuffixes(),
): boolean {
  const host = normalizeHost(hostname);
  if (host.length === 0) return false;
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}
