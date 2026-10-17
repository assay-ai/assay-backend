import { SnapshotEntry } from './snapshot';

/**
 * The self-routing disclosure (design spec §7.7, "Self-routing disclosure"):
 * the badge "Routes to the publisher's own provider" follows the **effect** of
 * a published version's entry rules, not the mode the publisher picked. It
 * shows when, for at least one tool, the rules leave only providers owned by
 * the publisher's organization — through ONLY, EXCLUDE, a price cap, or a
 * standard tool that only the publisher serves.
 *
 * Pure. Judged against the bindings that serve now (`ACTIVE`), so a rival
 * provider binding the tool later clears the badge. The provider tier is not
 * judged here: it would need live stats, and a tier floor only ever narrows,
 * so leaving it out can hide the badge but never invent it. `min_quality` is
 * inert until backlog G1.1.
 */

/** One `ACTIVE` binding of a tool, as the disclosure needs it. */
export interface ServingBinding {
  readonly toolId: string;
  /** `providerId === organizationId`. */
  readonly providerId: string;
  /** In the asset's base units. */
  readonly priceAmount: string;
  readonly assetId: string;
}

const INTEGER = /^\d+$/;

/** The providers `entry` leaves to route to, in the router's terms. */
export function providersLeft(
  entry: SnapshotEntry,
  bindings: readonly ServingBinding[],
): Set<string> {
  const serving = bindings.filter((binding) => binding.toolId === entry.toolId);
  const listed = new Set(entry.providerIds);
  const left = serving.filter((binding) => {
    if (entry.providerMode === 'ONLY' && !listed.has(binding.providerId)) return false;
    if (entry.providerMode === 'EXCLUDE' && listed.has(binding.providerId)) return false;
    if (entry.maxPrice) {
      // Another asset is not comparable, so it fails the cap, as in the router.
      if (binding.assetId !== entry.maxPrice.asset) return false;
      if (!INTEGER.test(binding.priceAmount) || !INTEGER.test(entry.maxPrice.amount)) return false;
      if (BigInt(binding.priceAmount) > BigInt(entry.maxPrice.amount)) return false;
    }
    return true;
  });
  // FALLBACK_BEST drops the entry's preferences when they leave nobody.
  const routed = left.length === 0 && entry.onEmpty === 'FALLBACK_BEST' ? serving : left;
  return new Set(routed.map((binding) => binding.providerId));
}

/** Whether any entry leaves only the publisher's own provider. Official sets never do. */
export function routesToPublisher(
  entries: readonly SnapshotEntry[],
  publisherOrgId: string | null,
  bindings: readonly ServingBinding[],
): boolean {
  if (publisherOrgId === null) return false;
  return entries.some((entry) => {
    const left = providersLeft(entry, bindings);
    return left.size > 0 && [...left].every((providerId) => providerId === publisherOrgId);
  });
}
