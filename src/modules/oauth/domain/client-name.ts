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
 * Matched on a folded copy, each character folded by {@link foldForMatch}
 * (the consent page's `foldForMatch`, the same table, checked by the shared
 * vectors in `client-name-fold.vectors.json`), so spelling tricks do not hide
 * a phrase. Invisible characters (Cf, Cc, variation selectors) and combining
 * marks are removed first.
 *
 * Word boundaries are a separator, the ends, a lower-to-upper case change, or
 * a separator letter: a modifier letter (Lm, e.g. `ʼ`), the Arabic tatweel,
 * or an enclosed, circled or parenthesised letter or digit (`ⓡ`), each of
 * which also separates words wherever it sits. "verified" counts when a word
 * starts with it ("Verifieds", "Verified2026", "ClaudeVerified"); the other
 * phrases count only as whole words, so "Verifone", "Assayer Labs" and "Assay
 * Application" pass while "V e r i f i e d", "Vеrіfіеd" and "Verifiedʼ" do
 * not.
 */
export function claimsTrust(name: string): boolean {
  if (CHECK_MARK_RE.test(name.normalize('NFKC'))) return true;
  const chars = [...name.replace(INVISIBLE_RE, '').replace(/\p{M}/gu, '')];

  const separatorLetter = chars.map((c) => SEPARATOR_LETTER_RE.test(c));
  const word = chars.map((c, i) => !separatorLetter[i] && WORD_CHAR_RE.test(c));
  // Separators, symbols and punctuation fold to nothing and separate words; a
  // separator letter keeps the letter it stands for but separates words too.
  const folded = chars.map((c, i) => (word[i] || separatorLetter[i] ? foldForMatch(c) : ''));

  const caseChange = (i: number): boolean => LOWER_RE.test(chars[i]) && UPPER_RE.test(chars[i + 1]);
  const startsWord = (i: number): boolean =>
    i === 0 || !word[i - 1] || separatorLetter[i] || caseChange(i - 1);
  const endsWord = (i: number): boolean =>
    i === chars.length - 1 || !word[i + 1] || separatorLetter[i] || caseChange(i);

  // Offsets of each character's fold in the joined string.
  const offsets: number[] = [];
  let joined = '';
  for (const piece of folded) {
    offsets.push(joined.length);
    joined += piece;
  }

  for (const { target, prefix } of TRUST_TARGETS) {
    for (let at = joined.indexOf(target); at >= 0; at = joined.indexOf(target, at + 1)) {
      const first = offsets.findIndex((offset, i) => offset === at && folded[i] !== '');
      if (first < 0 || !startsWord(first)) continue;
      if (prefix) return true;
      const end = at + target.length;
      const last = offsets.findIndex(
        (offset, i) => folded[i] !== '' && offset + folded[i].length === end,
      );
      if (last >= first && endsWord(last)) return true;
    }
  }
  return false;
}

/**
 * Whether a word of the name mixes Latin letters with letters of another
 * script (UTS #39 "highly restrictive", per word): `Ꮩerified` (Cherokee),
 * `ꓦerified` (Lisu), `ᐯerified` (Canadian syllabics), `Vеrified` (Cyrillic).
 * A DCR registration or a CIMD document with such a name is refused; the
 * consent page shows the domain instead. Words are split as for matching,
 * and each is compared after NFKC, so mathematical and fullwidth letters
 * count as Latin.
 *
 * Common and inherited characters (digits, marks) belong to no script. As in
 * UTS #39, Latin may join Han, Hiragana, Katakana, Hangul and Bopomofo, so
 * "Gitクライアント" passes. A name wholly in one script passes ("Ассистент",
 * "日本語ツール").
 */
export function mixesScripts(name: string): boolean {
  const words = name.replace(INVISIBLE_RE, '').split(WORD_SPLIT_RE);
  for (const part of words) {
    let latin = false;
    let other = false;
    for (const c of part.normalize('NFKC')) {
      if (!LETTER_RE.test(c)) continue;
      if (LATIN_RE.test(c)) latin = true;
      else if (!LATIN_COMPANION_RE.test(c)) other = true;
    }
    if (latin && other) return true;
  }
  return false;
}

/** Check marks and ticks, in any form (also the square-root tick). */
const CHECK_MARK_RE = /[\u2713\u2714\u2611\u2705\u221A\u237B\u{1F5F8}\u{1F5F9}\u{10102}]/u;
/** Removed before matching, so a phrase split by them joins up again. */
const INVISIBLE_RE = /[\p{Cf}\p{Cc}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
/** A letter, a digit, or `|` (a stand-in for i). Everything else separates words. */
const WORD_CHAR_RE = /^[\p{L}\p{N}|]$/u;
const LOWER_RE = /^\p{Ll}$/u;
const UPPER_RE = /^\p{Lu}$/u;
/**
 * Separator letters: modifier letters (Lm), the Arabic tatweel, and enclosed,
 * circled and parenthesised letters and digits. They separate words, and fold
 * to the plain letter or digit they stand for, or to nothing.
 */
const SEPARATOR_LETTER_RE =
  /^[\p{Lm}\u0640\u2460-\u24FF\u2776-\u2793\u3200-\u32FF\u{1F100}-\u{1F1FF}]$/u;
/** What a separator letter keeps of its fold: plain letters and digits, never a modifier letter. */
const NOT_PLAIN_LETTER_RE = /[^\p{Ll}\p{Lu}\p{Lt}\p{Lo}\p{N}]/gu;
/** Ignored between letters when matching: whitespace, `_`, `-` (any dash), `.`. */
const MATCH_SEPARATOR_RE = /^[\s_.\p{Pd}]$/u;
/** Splits a name into words for the script check. */
const WORD_SPLIT_RE =
  /[^\p{L}\p{M}\p{N}]|[\p{Lm}\u0640\u2460-\u24FF\u2776-\u2793\u3200-\u32FF\u{1F100}-\u{1F1FF}]/u;
const LETTER_RE = /^\p{L}$/u;
const LATIN_RE = /^\p{sc=Latin}$/u;
/** Scripts a word may mix with Latin: none of theirs, plus the CJK set of UTS #39. */
const LATIN_COMPANION_RE =
  /^[\p{sc=Common}\p{sc=Inherited}\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Bopomofo}]$/u;

/**
 * Letters of other scripts, and Latin variants, that look like plain Latin
 * ones. Keys are lower case, as `foldForMatch` looks them up after lower
 * casing. The consent page's table is the same, entry for entry.
 */
// prettier-ignore
const LATIN_LOOKALIKES: Readonly<Record<string, string>> = {
  // Cyrillic
  '\u0430': 'a', '\u0435': 'e', '\u0451': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x',
  '\u0443': 'y', '\u0456': 'i', '\u0457': 'i', '\u0458': 'j', '\u0455': 's', '\u0501': 'd', '\u0475': 'v',
  '\u04cf': 'i', '\u04bd': 'e', '\u0433': 'r', '\u0493': 'f', '\u051b': 'q', '\u051d': 'w', '\u0261': 'g',
  // Greek (ς: the lunate sigma ϲ decomposes to it)
  '\u03bf': 'o', '\u03bd': 'v', '\u03b9': 'i', '\u03b5': 'e', '\u03f5': 'e', '\u03c1': 'p', '\u03ba': 'k',
  '\u03c5': 'u', '\u03c4': 't', '\u03b1': 'a', '\u03dd': 'f', '\u03c2': 'c', '\u03b3': 'y', '\u03c7': 'x',
  // Latin variants
  '\u0131': 'i', '\u0269': 'i', '\u0257': 'd', '\u0192': 'f', '\u0111': 'd',
  // Latin small capitals
  '\u1d00': 'a', '\u0299': 'b', '\u1d04': 'c', '\u1d05': 'd', '\u1d07': 'e', '\ua730': 'f', '\u0262': 'g',
  '\u029c': 'h', '\u026a': 'i', '\u1d0a': 'j', '\u1d0b': 'k', '\u029f': 'l', '\u1d0d': 'm', '\u0274': 'n',
  '\u1d0f': 'o', '\u1d18': 'p', '\ua7af': 'q', '\u0280': 'r', '\ua731': 's', '\u1d1b': 't', '\u1d1c': 'u',
  '\u1d20': 'v', '\u1d21': 'w', '\u028f': 'y', '\u1d22': 'z',
  // Cherokee, by the lower case form of each capital (Ꭺ U+13AA → U+AB7A)
  '\uab7a': 'a', '\u13fc': 'b', '\uab9f': 'b', '\uabaf': 'c', '\uab70': 'd', '\uab7c': 'e', '\uab90': 'g',
  '\uab8b': 'h', '\uab92': 'h', '\uab75': 'i', '\uab7b': 'j', '\uabb6': 'k', '\uabae': 'l', '\uab87': 'm',
  '\uabb2': 'p', '\uaba2': 'r', '\uab71': 'r', '\uabaa': 's', '\uab72': 't', '\uaba9': 'v', '\uab83': 'w',
  '\uaba4': 'w', '\uab79': 'y', '\uab93': 'z',
  // Lisu
  '\ua4ee': 'a', '\ua4d0': 'b', '\ua4da': 'c', '\ua4d3': 'd', '\ua4f0': 'e', '\ua4dd': 'f', '\ua4d6': 'g',
  '\ua4e7': 'h', '\ua4f2': 'i', '\ua4d9': 'j', '\ua4d7': 'k', '\ua4e1': 'l', '\ua4df': 'm', '\ua4e0': 'n',
  '\ua4f3': 'o', '\ua4d1': 'p', '\ua4e3': 'r', '\ua4e2': 's', '\ua4d4': 't', '\ua4f4': 'u', '\ua4e6': 'v',
  '\ua4ea': 'w', '\ua4eb': 'x', '\ua4ec': 'y', '\ua4dc': 'z',
  // Canadian syllabics
  '\u15c5': 'a', '\u15f7': 'b', '\u1455': 'c', '\u15ea': 'd', '\u15f4': 'e', '\u15b4': 'f', '\u157c': 'h',
  '\u148d': 'j', '\u14aa': 'l', '\u15f0': 'm', '\u144e': 'n', '\u146d': 'p', '\u146b': 'q', '\u1587': 'r',
  '\u1515': 's', '\u144c': 'u', '\u142f': 'v', '\u15ef': 'w', '\u1614': 'z',
};

/** Digits and signs that stand in for letters. */
const LETTER_STANDINS: Readonly<Record<string, string>> = {
  '\u0031': 'i',
  l: 'i',
  '\u007c': 'i',
  '\u0033': 'e',
  '\u0030': 'o',
  '\u0035': 's',
  '\u0034': 'a',
};

/**
 * One character, folded for matching (the consent page's `foldForMatch`):
 * a separator (whitespace, `_`, a dash, `.`) to nothing; otherwise NFKD with
 * combining marks dropped, lower case, lookalike letters to Latin and digit
 * stand-ins (`1 l |`→i, `3`→e, `0`→o, `5`→s, `4`→a) to letters. A separator
 * letter keeps only the plain letters and digits of that (`ⓡ`→r, `⑴`→i,
 * `ʼ` and the tatweel → nothing).
 */
export function foldForMatch(char: string): string {
  if (MATCH_SEPARATOR_RE.test(char)) return '';
  const folded = [...char.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()]
    .map((c) => LATIN_LOOKALIKES[c] ?? LETTER_STANDINS[c] ?? c)
    .join('');
  return SEPARATOR_LETTER_RE.test(char) ? folded.replace(NOT_PLAIN_LETTER_RE, '') : folded;
}

/** The phrases, folded the same way, separators dropped; "verified" also as a word's start. */
const TRUST_TARGETS: readonly { target: string; prefix: boolean }[] = [
  { phrase: 'verified', prefix: true },
  { phrase: 'assay app', prefix: false },
  { phrase: 'says it is', prefix: false },
  { phrase: 'an app on this computer', prefix: false },
].map(({ phrase, prefix }) => ({
  target: [...phrase.replace(/\s+/g, '')].map(foldForMatch).join(''),
  prefix,
}));
