/**
 * A client's self-declared name, made safe to show on the consent page and to
 * store in `oauth_clients.client_name varchar(64)` (spec §6.2, §6.3.7).
 *
 * Strips control (Cc), format (Cf, which holds every bidi control: LRM, RLM,
 * ALM, LRE…RLO, LRI…PDI, plus zero-width and tag characters), line and
 * paragraph separators (Zl, Zp) and lone surrogates (Cs); collapses whitespace
 * runs to one space; trims. Also strips private-use (Co) and unassigned (Cn)
 * code points and the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), which
 * render blank. The result must be 1–64 code points, contain at least one
 * letter or digit, and stack at most two combining marks on a base, or `null`.
 * Never truncated: an over-long name is refused, not shortened.
 */
export const CLIENT_NAME_MAX = 64;

const STRIP_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Cn}\u115F\u1160\u3164\uFFA0]/gu;
const MARK_STACK_RE = /\p{M}{3,}/u;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;
const SPACE_RUN_RE = /\s+/gu;

export function sanitise(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const cleaned = name.replace(STRIP_RE, '').replace(SPACE_RUN_RE, ' ').trim();
  const length = [...cleaned].length;
  if (length < 1 || length > CLIENT_NAME_MAX) return null;
  if (MARK_STACK_RE.test(cleaned) || !LETTER_OR_DIGIT_RE.test(cleaned)) return null;
  return cleaned;
}
