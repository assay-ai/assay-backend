import { Inject, Injectable } from '@nestjs/common';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { AssetId, ChainId } from '@modules/chains/ports/caip.types';

import { ToolCataloguePort } from '../ports/tool-catalogue.port';
import { BindingStatus, PricingMode, Tool, ToolBinding } from '../ports/tool.types';
import { TOOL_CATALOGUE_SNAPSHOT, ToolCatalogueSnapshot } from './in-memory-tool-catalogue';

/**
 * The catalogue, half seeded and half stored.
 *
 * ```text
 * findTool / listTools   the seed        the tool contract — ours to author
 * findBindings           tool_bindings   one provider's implementation — theirs
 * ```
 *
 * That split is deliberate, not a transitional state. A tool's
 * `inputSchema`, `outputSchema` and verification policy are the contract the
 * router substitutes providers *against*; they are authored by the platform
 * (the seeded launch catalogue) and a provider must not be
 * able to move them. A binding is the opposite: it is the provider's own
 * adaptation of their own endpoint, it changes without a deploy, and until
 * this class existed there was nowhere for it to live except a seed file that
 * only an operator could edit — which made "open registration" true
 * only up to the point where a provider actually wanted to serve traffic.
 *
 * Nothing about the router changes. `ToolCataloguePort` was written with this
 * swap named in its own doc comment, `TOOL_CATALOGUE` moves from
 * `InMemoryToolCatalogue` to this class in `ToolModule`, and
 * `tool-module-wiring.spec.ts` keeps resolving the token rather than the class.
 *
 * `InMemoryToolCatalogue` stays: it is what the seed still loads for tools, and
 * it is what unit tests of the router run against.
 */
@Injectable()
export class DatabaseToolCatalogue implements ToolCataloguePort {
  private readonly tools: ReadonlyMap<string, Tool>;

  constructor(
    @Inject(TOOL_CATALOGUE_SNAPSHOT) snapshot: ToolCatalogueSnapshot,
    private readonly bindings: ToolBindingRepository,
  ) {
    this.tools = new Map(snapshot.tools.map((tool) => [tool.id, tool]));
  }

  findTool(toolId: string): Promise<Tool | null> {
    return Promise.resolve(this.tools.get(toolId) ?? null);
  }

  listTools(): Promise<readonly Tool[]> {
    return Promise.resolve([...this.tools.values()]);
  }

  /**
   * Every binding for the tool, in any state — the port's contract, unchanged.
   *
   * A seeded binding for the same tool is **not** merged in. Two sources for
   * one answer is how a binding a provider paused in the console keeps taking
   * traffic because a seed file still lists it, and the seed's `bindings` array
   * is now only read by tests that construct `InMemoryToolCatalogue` directly.
   */
  async findBindings(toolId: string): Promise<readonly ToolBinding[]> {
    if (!this.tools.has(toolId)) return [];

    const rows = await this.bindings.findByTool(toolId);
    return rows.map(toToolBinding);
  }
}

/**
 * `tool_bindings` row → the domain type.
 *
 * The one translation worth naming: `mapping_version` becomes `version`.
 * `version` on the row is TypeORM's optimistic lock and means nothing to the
 * router; `version` in the domain is which revision of the mappings served the
 * call, which is the number a dispute is argued over. Doing the swap here, once,
 * is what keeps the two from ever being read as each other.
 */
export function toToolBinding(row: ToolBindingEntity): ToolBinding {
  return {
    id: row.id,
    toolId: row.toolId,
    // `providerId === organizationId`, the equivalence the whole provider
    // surface rests on. There is no second column, so there is nothing to
    // disagree with.
    providerId: row.organizationId,
    endpoint: row.endpoint,
    requestMapping: row.requestMapping,
    responseMapping: row.responseMapping,
    pricingMode: row.pricingMode as PricingMode,
    priceAmount: row.priceAmount,
    assetId: row.assetId as AssetId,
    // Copied, never derived. `?? [chainIdOf(row.assetId)]` here would make the
    // column unobservable — a provider who stopped offering a chain would keep
    // routing on it, and every read would agree with the write that never
    // happened. The column is `NOT NULL` with a non-empty CHECK, so the only
    // rows that reach this line already name their chains.
    settlementChains: row.settlementChains as ChainId[],
    freeQuotaPerAgent: row.freeQuotaPerAgent,
    freeDailyBudget: row.freeDailyBudget === null ? null : Number(row.freeDailyBudget),
    // The ceilings travel with the candidate. `pause_reason` and
    // `paused_at` deliberately do not: the router only needs `status`, and
    // nothing outside the provider console reads why a pause happened.
    maxRps: row.maxRps,
    maxDailyCalls: row.maxDailyCalls,
    slaFailureRate: Number(row.slaFailureRate),
    timeoutMs: row.timeoutMs,
    status: row.status as BindingStatus,
    version: row.mappingVersion,
  };
}
