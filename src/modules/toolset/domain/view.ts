import { ProviderTier } from '@modules/provider/ports/provider.types';
import { AssetId } from '@modules/chains/ports/caip.types';
import { EntryRoutingRules, OnEmpty, ProviderMode } from '@modules/tool/domain/routing';
import { PricingMode, Tool, categoryOf } from '@modules/tool/ports/tool.types';
import { MoneyUtil } from '@utils/money.util';

import { EndpointKind, McpPath, ViewFilter } from './mcp-url';

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
}

export interface ViewToolset {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** `null` — the Draft. A published version is T2. */
  readonly version: number | null;
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
  view: Pick<McpEndpointView, 'baseToolIds' | 'filter'>,
  catalogue: readonly Tool[],
): { readonly tools: readonly Tool[]; readonly ignoredTools: readonly string[] } {
  const byId = new Map(catalogue.map((tool) => [tool.id, tool]));
  let tools: Tool[] = view.baseToolIds
    ? view.baseToolIds.flatMap((id) => {
        const tool = byId.get(id);
        return tool ? [tool] : [];
      })
    : [...catalogue];

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

  return { tools, ignoredTools: ignored.sort() };
}

/** `?free=1` keeps only tools that can be served free (FR-2). */
export function servesPricingMode(filter: ViewFilter, mode: PricingMode | null): boolean {
  if (!filter.free) return true;
  return mode === PricingMode.FREE || mode === PricingMode.FREEMIUM;
}
