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
 *
 * `max` is 64 for a client name; the consent API also uses it, with its own
 * limit, for a credential name and a device label.
 */
export const CLIENT_NAME_MAX = 64;

const STRIP_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Cn}\u115F\u1160\u3164\uFFA0]/gu;
const MARK_STACK_RE = /\p{M}{3,}/u;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;
const SPACE_RUN_RE = /\s+/gu;

export function sanitise(name: unknown, max: number = CLIENT_NAME_MAX): string | null {
  if (typeof name !== 'string') return null;
  const cleaned = name.replace(STRIP_RE, '').replace(SPACE_RUN_RE, ' ').trim();
  const length = [...cleaned].length;
  if (length < 1 || length > max) return null;
  if (MARK_STACK_RE.test(cleaned) || !LETTER_OR_DIGIT_RE.test(cleaned)) return null;
  return cleaned;
}

/**
 * Whether a client's name claims trust it was never given (spec §6.3.6,
 * R-OA-25): the word "verified", the built-in app's own header words
 * ("Assay app", "says it is", "an app on this computer"), or a check mark.
 * A DCR registration or a CIMD document with such a name is refused
 * (`invalid_client_metadata`). The built-in client's own document never
 * passes through here, so its "Assay app (assay-mcp)" is unaffected.
 *
 * Matched on a folded copy, the same fold as the consent page's
 * `foldForMatch`, so spelling tricks do not hide a phrase:
 *
 * ```text
 * NFKC, then invisible characters (Cf, Cc, variation selectors) removed
 * per character: NFKD, combining marks (M) dropped, lower case,
 *   Cyrillic/Greek lookalikes → Latin, 1 l | → i, 3 → e, 0 → o, 5 → s, 4 → a
 * whitespace, _ - . between letters ignored; symbols (So, Sk) separate words
 * ```
 *
 * A phrase counts only on word boundaries (a separator, the ends, or a
 * lower-to-upper case change), so "Verifone", "Assayer Labs" and "Assay
 * Application" pass while "V e r i f i e d", "Vеrіfіеd" and "ClaudeVerified"
 * do not.
 */
export function claimsTrust(name: string): boolean {
  const normalised = name.normalize('NFKC');
  if (CHECK_MARK_RE.test(normalised)) return true;
  // Combining marks left after NFKC are dropped, so a mark after the last
  // letter of a phrase cannot hide its word boundary.
  const chars = [...normalised.replace(INVISIBLE_RE, '').replace(/\p{M}/gu, '')];

  const word = chars.map((c) => WORD_CHAR_RE.test(c));
  // Separators, symbols and punctuation fold to nothing and separate words.
  const folded = chars.map((c, i) => (word[i] ? foldChar(c) : ''));

  const startsWord = (i: number): boolean =>
    i === 0 || !word[i - 1] || (LOWER_RE.test(chars[i - 1]) && UPPER_RE.test(chars[i]));
  const endsWord = (i: number): boolean =>
    i === chars.length - 1 ||
    !word[i + 1] ||
    (LOWER_RE.test(chars[i]) && UPPER_RE.test(chars[i + 1]));

  // Offsets of each character's fold in the joined string.
  const offsets: number[] = [];
  let joined = '';
  for (const piece of folded) {
    offsets.push(joined.length);
    joined += piece;
  }

  for (const target of TRUST_TARGETS) {
    for (let at = joined.indexOf(target); at >= 0; at = joined.indexOf(target, at + 1)) {
      const first = offsets.findIndex((offset, i) => offset === at && folded[i] !== '');
      const end = at + target.length;
      const last = offsets.findIndex(
        (offset, i) => folded[i] !== '' && offset + folded[i].length === end,
      );
      if (first >= 0 && last >= first && startsWord(first) && endsWord(last)) return true;
    }
  }
  return false;
}

/** Check marks and ticks, in any form (also the square-root tick). */
const CHECK_MARK_RE = /[\u2713\u2714\u2611\u2705\u221A\u237B\u{1F5F8}\u{1F5F9}\u{10102}]/u;
/** Removed before matching, so a phrase split by them joins up again. */
const INVISIBLE_RE = /[\p{Cf}\p{Cc}︀-️\u{E0100}-\u{E01EF}]/gu;
/** A letter, a digit, or `|` (a stand-in for i). Everything else separates words. */
const WORD_CHAR_RE = /^[\p{L}\p{N}|]$/u;
const LOWER_RE = /^\p{Ll}$/u;
const UPPER_RE = /^\p{Lu}$/u;

/** Cyrillic and Greek letters that look like Latin ones (the consent page's table). */
const LATIN_LOOKALIKES: Readonly<Record<string, string>> = {
  // Cyrillic
  а: 'a',
  е: 'e',
  ё: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  у: 'y',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ѵ: 'v',
  ӏ: 'i',
  ҽ: 'e',
  г: 'r',
  ғ: 'f',
  ԛ: 'q',
  ԝ: 'w',
  ɡ: 'g',
  // Greek
  ο: 'o',
  ν: 'v',
  ι: 'i',
  ε: 'e',
  ϵ: 'e',
  ρ: 'p',
  κ: 'k',
  υ: 'u',
  τ: 't',
  α: 'a',
  ϝ: 'f',
  ϲ: 'c',
  γ: 'y',
  χ: 'x',
  // Latin variants
  ı: 'i',
  ɩ: 'i',
  ʀ: 'r',
  ᴠ: 'v',
  ᴇ: 'e',
  ɗ: 'd',
  ƒ: 'f',
};

/** Digits and signs that stand in for letters. */
const LETTER_STANDINS: Readonly<Record<string, string>> = {
  '1': 'i',
  l: 'i',
  '|': 'i',
  '3': 'e',
  '0': 'o',
  '5': 's',
  '4': 'a',
};

/** One character, folded for matching (the consent page's `foldForMatch`). */
function foldChar(char: string): string {
  return [...char.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()]
    .map((c) => LATIN_LOOKALIKES[c] ?? LETTER_STANDINS[c] ?? c)
    .join('');
}

/** The phrases, folded the same way, separators dropped. */
const TRUST_TARGETS: readonly string[] = [
  'verified',
  'assay app',
  'says it is',
  'an app on this computer',
].map((phrase) => [...phrase.replace(/\s+/g, '')].map(foldChar).join(''));
