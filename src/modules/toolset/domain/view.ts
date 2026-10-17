import { ProviderTier } from '@modules/provider/ports/provider.types';
import { AssetId } from '@modules/chains/ports/caip.types';
import { EntryRoutingRules, OnEmpty, ProviderMode } from '@modules/tool/domain/routing';
import { PricingMode, Tool, categoryOf, isListedTool } from '@modules/tool/ports/tool.types';
import { MoneyUtil } from '@utils/money.util';

import { DiscoveryMode, EndpointKind, McpPath, ViewFilter } from './mcp-url';

/**
 * What one MCP URL serves, before access (design spec §7.3):
 *
 * ```text
 * view = the URL's tools (the catalogue, or a toolset's entries, in order)
 *        ∩ ?tools=  ∩ ?category=  ∩ (?free=1 → FREE or FREEMIUM only)
 * ```
 *
 * Filters only narrow. `?free=1` needs a price to decide, so it is applied by
 * whoever priced the tool ({@link servesPricingMode}); everything else is
 * decided here from the catalogue alone.
 */
export interface McpEndpointView {
  readonly canonicalUrl: string;
  readonly path: McpPath;
  readonly kind: EndpointKind;
  readonly filter: ViewFilter;
  /** The toolset this URL serves, or `null` on `/`, `/c/…` and `/@handle`. */
  readonly toolset: ViewToolset | null;
  readonly handle: string | null;
  /** The URL's own tools in order, or `null` for the whole LISTED catalogue. */
  readonly baseToolIds: readonly string[] | null;
  /** The entry rules of the toolset this URL serves, by tool id. */
  readonly entryRules: ReadonlyMap<string, EntryRoutingRules>;
  /**
   * `/c/{category}`: the path's own topic, applied like `?category=` (and
   * intersected with it). Absent or `null` elsewhere.
   */
  readonly baseCategory?: string | null;
  /**
   * How `tools/list` presents this URL (§7.4, "Discovery modes"), before a
   * `?discovery=` override: the Draft's settings on `/my/{slug}`, the
   * published snapshot's on `/my/{slug}@n`, `/@…` and `/u/…`. Absent means
   * the path's static default with no pins — see `discoveryOf` — so a
   * resolver case that predates T2 still serves a sensible list.
   */
  readonly discovery?: ViewDiscovery;
  /** Set when a shared URL serves only through a grace period or a rename alias. */
  readonly notice?: ViewNotice | null;
}

export interface ViewNotice {
  /** `_meta["assay/sharingEnds"]`: the URL stops serving then. */
  readonly sharingEndsAt: Date | null;
  /** `_meta["assay/renamed"]`: the handle in the URL is an old one; this is the current. */
  readonly renamedTo: string | null;
}

/** A URL's discovery settings: the toolset's, or the path's defaults. */
export interface ViewDiscovery {
  readonly mode: DiscoveryMode;
  /** AUTO turns to SEARCH above this many tools in view ∩ access. */
  readonly searchThreshold: number;
  /** The URL's "Always loaded" names (the toolset's, or the root's), at most 5. */
  readonly pinnedTools: readonly string[];
}

/** The default `search_threshold` (design spec §13 D2). */
export const DEFAULT_SEARCH_THRESHOLD = 25;

export interface ViewToolset {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** The published version served, or `null` for the Draft (`/my/{slug}`). */
  readonly version: number | null;
  /** Set on a URL with no `@n`: it follows the latest version (`_meta["assay/toolsetVersion"]`). */
  readonly latest: boolean;
}

/** The fields of a `toolset_entries` row the rules are built from. */
export interface StoredEntryRule {
  readonly providerMode: string;
  readonly providerIds: readonly string[];
  readonly minTier: string | null;
  readonly maxPriceAmount: string | null;
  readonly maxPriceAssetId: string | null;
  readonly maxPriceDecimals: number | null;
  readonly minQuality: string | null;
  readonly onEmpty: string;
}

/** A stored entry → the router's rules, or `null` when the entry sets nothing. */
export function entryRulesOf(entry: StoredEntryRule): EntryRoutingRules | null {
  const rules: EntryRoutingRules = {
    mode: entry.providerMode as ProviderMode,
    providerIds: [...entry.providerIds],
    minTier: (entry.minTier as ProviderTier | null) ?? null,
    maxPrice:
      entry.maxPriceAmount !== null && entry.maxPriceAssetId && entry.maxPriceDecimals !== null
        ? MoneyUtil.of(
            entry.maxPriceAmount,
            entry.maxPriceAssetId as AssetId,
            entry.maxPriceDecimals,
          )
        : null,
    minQuality: entry.minQuality === null ? null : Number(entry.minQuality),
    onEmpty: entry.onEmpty as OnEmpty,
  };
  const empty =
    rules.mode === ProviderMode.BEST &&
    rules.minTier === null &&
    rules.maxPrice === null &&
    rules.minQuality === null;
  return empty ? null : rules;
}

/** The view's tools from `catalogue`, in the URL's order, and the `?tools=` names it ignored. */
export function selectViewTools(
  view: Pick<McpEndpointView, 'baseToolIds' | 'filter' | 'baseCategory'>,
  catalogue: readonly Tool[],
): { readonly tools: readonly Tool[]; readonly ignoredTools: readonly string[] } {
  const byId = new Map(catalogue.map((tool) => [tool.id, tool]));
  let tools: Tool[] = view.baseToolIds
    ? view.baseToolIds.flatMap((id) => {
        const tool = byId.get(id);
        return tool ? [tool] : [];
      })
    : // The catalogue-wide views serve the LISTED catalogue only: an UNLISTED
      // or PRIVATE tool is reachable only through a toolset that holds it.
      catalogue.filter(isListedTool);

  const ignored: string[] = [];
  if (view.filter.tools) {
    const names = new Set<string>();
    for (const selector of view.filter.tools) {
      // Every tool has one contract major until versions arrive (T3), so a
      // pin to any other major names nothing that exists.
      if (selector.major !== null && selector.major !== 1) {
        ignored.push(`${selector.name}@${selector.major}`);
        continue;
      }
      names.add(selector.name);
    }
    const present = new Set(tools.map((tool) => tool.name));
    for (const name of names) if (!present.has(name)) ignored.push(name);
    tools = tools.filter((tool) => names.has(tool.name));
  }

  if (view.filter.categories) {
    const categories = new Set(view.filter.categories);
    tools = tools.filter((tool) => categories.has(categoryOf(tool)));
  }

  if (view.baseCategory) {
    tools = tools.filter((tool) => categoryOf(tool) === view.baseCategory);
  }

  return { tools, ignoredTools: ignored.sort() };
}

/** `?free=1` keeps only tools that can be served free (FR-2). */
export function servesPricingMode(filter: ViewFilter, mode: PricingMode | null): boolean {
  if (!filter.free) return true;
  return mode === PricingMode.FREE || mode === PricingMode.FREEMIUM;
}

/**
 * The `_meta` a list result carries for its URL (design spec §7.4):
 * `assay/toolsetVersion` on a latest URL, `assay/sharingEnds` while a shared
 * URL serves only through a grace period, `assay/renamed` on an old handle.
 */
export function listMetaOf(view: McpEndpointView | null | undefined): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (!view) return meta;
  if (view.toolset?.latest && view.toolset.version !== null) {
    meta['assay/toolsetVersion'] = view.toolset.version;
  }
  if (view.notice?.sharingEndsAt) {
    meta['assay/sharingEnds'] = view.notice.sharingEndsAt.toISOString();
  }
  if (view.notice?.renamedTo) meta['assay/renamed'] = { to: view.notice.renamedTo };
  return meta;
}
