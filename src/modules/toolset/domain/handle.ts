/**
 * Handles: an organization's public namespace, `@acme` (design spec §7.1).
 *
 * Pure. The format, the reserved words and the claim gate's arithmetic live
 * here; `HandlesService` reads the database and applies them.
 *
 * ```text
 * format       ^[a-z][a-z0-9-]{2,23}$   lowercase only, no `_` (so `__` is always the separator)
 * unique       across every organization, ignoring case, including held old handles
 * reserved     RESERVED_HANDLES ∪ every category name
 * claim gate   the organization is verified; one Privy user claims for ≤ 3 orgs in 30 days
 * change       free until `handle_locked_at`; after it, only through an operator (two-person)
 * ```
 */

export const HANDLE_RE = /^[a-z][a-z0-9-]{2,23}$/;

/** The handle Official (platform) toolsets are served under: `/@assay/{slug}`. */
export const OFFICIAL_HANDLE = 'assay';

/** §7.1, verbatim. Category names are reserved too ({@link handleRefusal}). */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'assay',
  'official',
  'platform',
  'system',
  'admin',
  'operator',
  'mcp',
  'x402',
  'std',
  'standard',
  'tool',
  'tools',
  'toolset',
  'toolsets',
  'my',
  'u',
  'c',
  't',
  'api',
  'docs',
  'status',
  'health',
  'support',
  'help',
]);

/**
 * Category names reserved even before a tool uses them, so a handle cannot
 * pre-empt a topic URL (`/c/{category}`) the catalogue will grow into. The
 * categories present in `tools` are added at claim time.
 */
export const RESERVED_CATEGORY_NAMES: ReadonlySet<string> = new Set([
  'weather',
  'finance',
  'maps',
  'crypto',
  'web',
  'knowledge',
  'search',
  'news',
  'social',
  'data',
  'code',
  'chat',
  'ai',
  'media',
  'commerce',
  'travel',
  'sports',
  'health-care',
  'uncategorised',
]);

/** One Privy user may claim handles for at most this many organizations… */
export const HANDLE_CLAIM_MAX_ORGS = 3;
/** …within this window. */
export const HANDLE_CLAIM_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** How long an operator rename keeps the old handle serving as an alias. */
export const HANDLE_ALIAS_MS = 90 * 24 * 60 * 60 * 1000;

export enum HandleStatus {
  ACTIVE = 'ACTIVE',
  /** Taken down for abuse, or its organization was deleted: nothing under it serves. */
  FROZEN = 'FROZEN',
}

export enum HandleHistoryReason {
  RENAME = 'RENAME',
  TAKEDOWN = 'TAKEDOWN',
  ORG_DELETED = 'ORG_DELETED',
}

export type HandleRefusal = 'FORMAT' | 'RESERVED';

/**
 * Words that claim to speak for the platform. A handle is refused when one
 * of its `-`-separated parts reads as one of them, alone or with at most two
 * extra characters (`assay-ai`, `assay0`, `my-official-kit`, `supp0rt-team`),
 * so an ordinary word that merely contains one (`ecosystem`, `badminton`,
 * `staffing`) stays free.
 */
export const IMPERSONATION_WORDS: readonly string[] = [
  'assay',
  'goassay',
  'official',
  'platform',
  'system',
  'admin',
  'operator',
  'support',
  'staff',
  'moderator',
  'verified',
  'security',
  'x402',
];

/** The platform's own names: no handle may even start with one (`assayofficial`). */
export const BRAND_WORDS: readonly string[] = ['assay', 'goassay'];

/** Extra characters a part may carry and still read as an impersonation word. */
const IMPERSONATION_SLACK = 2;

/**
 * A handle's look-alike skeleton: what it reads as once the separators and
 * the usual confusables are folded — `rn`→`m`, `vv`→`w`, `cl`→`d`, `0`→`o`,
 * `1`/`i`→`l`, `3`→`e`, `4`→`a`, `5`→`s`, `7`→`t`, `8`→`b`, `9`→`g`.
 * Two handles with one skeleton are the same name to a reader.
 */
export function handleSkeleton(handle: string): string {
  const digits: Record<string, string> = {
    '0': 'o',
    '1': 'l',
    '3': 'e',
    '4': 'a',
    '5': 's',
    '7': 't',
    '8': 'b',
    '9': 'g',
  };
  return handle
    .toLowerCase()
    .replace(/-/g, '')
    .replace(/[0-9]/g, (digit) => digits[digit] ?? digit)
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/cl/g, 'd')
    .replace(/i/g, 'l');
}

/**
 * Why `handle` can never be claimed, or `null` when its shape is fine.
 * Availability (taken, held) is the database's question, not this one.
 *
 * Reserved: a reserved word or a category, or anything that reads as one
 * (`he1p`, `we4ther`); a part that reads as an impersonation word, give or
 * take two characters (`assay-ai`, `assay0`, `offlcial-tools`); anything
 * starting with the platform's name. Look-alikes of other organizations'
 * handles are refused by availability (`handle_skeleton`), not here.
 */
export function handleRefusal(
  handle: string,
  categories: Iterable<string> = [],
): HandleRefusal | null {
  if (!HANDLE_RE.test(handle)) return 'FORMAT';
  const skeleton = handleSkeleton(handle);
  for (const word of [...RESERVED_HANDLES, ...RESERVED_CATEGORY_NAMES, ...categories]) {
    if (word === handle || handleSkeleton(word) === skeleton) return 'RESERVED';
  }
  for (const part of handle.split('-').filter(Boolean).map(handleSkeleton)) {
    for (const word of IMPERSONATION_WORDS.map(handleSkeleton)) {
      const extra = part.length - word.length;
      if (extra < 0 || extra > IMPERSONATION_SLACK) continue;
      if (part.startsWith(word) || part.endsWith(word)) return 'RESERVED';
    }
  }
  for (const word of BRAND_WORDS.map(handleSkeleton)) {
    if (skeleton.startsWith(word)) return 'RESERVED';
  }
  return null;
}

/** A user-typed handle in the stored form: trimmed, lowercase, without a leading `@`. */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, '').toLowerCase();
}

/**
 * Whether one more claim by this Privy user stays within the gate.
 * `recentOrgIds`: the organizations this user claimed a handle for within the
 * window. Claiming again for one of them is never a new organization.
 */
export function claimGateAllows(recentOrgIds: readonly string[], organizationId: string): boolean {
  const orgs = new Set(recentOrgIds);
  if (orgs.has(organizationId)) return true;
  return orgs.size < HANDLE_CLAIM_MAX_ORGS;
}

/** A free handle near `base` for the "taken" message: `base-2`, `base-3`, … within 24 characters. */
export function handleSuggestions(base: string, count = 3): string[] {
  const stem = base.replace(/-+$/g, '').slice(0, 20) || 'org';
  const out: string[] = [];
  for (let n = 2; out.length < count && n < 100; n += 1) {
    const candidate = `${stem}-${n}`;
    if (HANDLE_RE.test(candidate)) out.push(candidate);
  }
  return out;
}
