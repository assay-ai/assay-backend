/**
 * A client's self-declared name, made safe to show on the consent page and to
 * store in `oauth_clients.client_name varchar(64)` (spec §6.2, §6.3.7).
 *
 * Strips control (Cc), format (Cf, which holds every bidi control: LRM, RLM,
 * ALM, LRE…RLO, LRI…PDI, plus zero-width and tag characters), line and
 * paragraph separators (Zl, Zp) and lone surrogates (Cs); collapses whitespace
 * runs to one space; trims. The result must be 1–64 code points, or `null`.
 * Never truncated: an over-long name is refused, not shortened.
 */
export const CLIENT_NAME_MAX = 64;

const STRIP_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;
const SPACE_RUN_RE = /\s+/gu;

export function sanitise(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const cleaned = name.replace(STRIP_RE, '').replace(SPACE_RUN_RE, ' ').trim();
  const length = [...cleaned].length;
  return length >= 1 && length <= CLIENT_NAME_MAX ? cleaned : null;
}
