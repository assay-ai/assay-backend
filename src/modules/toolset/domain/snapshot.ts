/**
 * A published toolset version: an immutable snapshot of everything its URLs
 * serve (design spec §7.2 `toolset_versions`, §7.7 "Draft and versions").
 *
 * Pure. The entries are stored as `jsonb` in exactly the shape below, so a
 * version keeps serving the same rules whatever later happens to the Draft.
 * {@link diffSnapshots} drives the generated changelog and the FR-17 notice.
 */

export interface SnapshotEntry {
  readonly toolId: string;
  /** The name at publish time, for the diff; serving resolves by id. */
  readonly toolName: string;
  readonly providerMode: string;
  readonly providerIds: readonly string[];
  readonly minTier: string | null;
  readonly maxPrice: {
    readonly amount: string;
    readonly asset: string;
    readonly decimals: number;
  } | null;
  readonly minQuality: number | null;
  /** T3: the contract majors this entry routes to (`^N`); `null` follows the current major. */
  readonly toolVersionRange?: string | null;
  readonly requireOutputFields: readonly string[];
  readonly onEmpty: string;
}

export interface ToolsetSnapshot {
  readonly entries: readonly SnapshotEntry[];
  readonly discovery: string;
  readonly searchThreshold: number;
  readonly pinnedTools: readonly string[];
  readonly name: string;
  readonly description: string | null;
  readonly icon: string | null;
}

export interface SnapshotDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Tools present in both whose provider rules differ. */
  readonly rulesChanged: readonly string[];
  /** `discovery`, `searchThreshold`, `pinnedTools`, `name`, `description`, `icon`. */
  readonly settingsChanged: readonly string[];
}

export const CHANGELOG_MAX_LENGTH = 500;

/** A stored `entries` value, read defensively: a malformed element is dropped. */
export function readSnapshotEntries(value: unknown): SnapshotEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): SnapshotEntry[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const e = raw as Record<string, unknown>;
    if (typeof e.toolId !== 'string') return [];
    const price = e.maxPrice as Record<string, unknown> | null | undefined;
    return [
      {
        toolId: e.toolId,
        toolName: typeof e.toolName === 'string' ? e.toolName : '',
        providerMode: typeof e.providerMode === 'string' ? e.providerMode : 'BEST',
        providerIds: Array.isArray(e.providerIds) ? e.providerIds.map(String) : [],
        minTier: typeof e.minTier === 'string' ? e.minTier : null,
        maxPrice:
          price && typeof price.amount === 'string' && typeof price.asset === 'string'
            ? { amount: price.amount, asset: price.asset, decimals: Number(price.decimals) }
            : null,
        minQuality: typeof e.minQuality === 'number' ? e.minQuality : null,
        ...(typeof e.toolVersionRange === 'string' ? { toolVersionRange: e.toolVersionRange } : {}),
        requireOutputFields: Array.isArray(e.requireOutputFields)
          ? e.requireOutputFields.map(String)
          : [],
        onEmpty: typeof e.onEmpty === 'string' ? e.onEmpty : 'FAIL',
      },
    ];
  });
}

export function diffSnapshots(
  before: ToolsetSnapshot | null,
  after: ToolsetSnapshot,
): SnapshotDiff {
  const old = new Map((before?.entries ?? []).map((entry) => [entry.toolId, entry]));
  const next = new Map(after.entries.map((entry) => [entry.toolId, entry]));
  const added = after.entries.filter((e) => !old.has(e.toolId)).map((e) => e.toolName);
  const removed = (before?.entries ?? []).filter((e) => !next.has(e.toolId)).map((e) => e.toolName);
  const rulesChanged = after.entries
    .filter((e) => old.has(e.toolId) && ruleKey(old.get(e.toolId)!) !== ruleKey(e))
    .map((e) => e.toolName);

  const settingsChanged: string[] = [];
  if (before) {
    if (before.discovery !== after.discovery) settingsChanged.push('discovery');
    if (before.searchThreshold !== after.searchThreshold) settingsChanged.push('searchThreshold');
    if (before.pinnedTools.join(',') !== after.pinnedTools.join(',')) {
      settingsChanged.push('pinnedTools');
    }
    if (before.name !== after.name) settingsChanged.push('name');
    if (before.description !== after.description) settingsChanged.push('description');
    if (before.icon !== after.icon) settingsChanged.push('icon');
  }
  return { added, removed, rulesChanged, settingsChanged };
}

export function isEmptyDiff(diff: SnapshotDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.rulesChanged.length === 0 &&
    diff.settingsChanged.length === 0
  );
}

/** The changelog generated from a diff when the owner writes none (§7.9). */
export function changelogOf(diff: SnapshotDiff, first: boolean): string {
  if (first) return truncate(`First version: ${diff.added.length} tools.`);
  const parts: string[] = [];
  if (diff.added.length) parts.push(`Added ${diff.added.join(', ')}.`);
  if (diff.removed.length) parts.push(`Removed ${diff.removed.join(', ')}.`);
  if (diff.rulesChanged.length) parts.push(`Changed rules for ${diff.rulesChanged.join(', ')}.`);
  if (diff.settingsChanged.length) parts.push(`Changed ${diff.settingsChanged.join(', ')}.`);
  return truncate(parts.length ? parts.join(' ') : 'No changes.');
}

function truncate(text: string): string {
  return text.length <= CHANGELOG_MAX_LENGTH ? text : `${text.slice(0, CHANGELOG_MAX_LENGTH - 1)}…`;
}

function ruleKey(entry: SnapshotEntry): string {
  return JSON.stringify([
    entry.providerMode,
    [...entry.providerIds].sort(),
    entry.minTier,
    entry.maxPrice,
    entry.minQuality,
    entry.toolVersionRange ?? null,
    [...entry.requireOutputFields].sort(),
    entry.onEmpty,
  ]);
}
