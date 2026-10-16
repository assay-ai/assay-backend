import { Inject, Injectable } from '@nestjs/common';

import { BindingVersionEntity } from '@database/postgres/entities/binding-version.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { BindingVersionRepository } from '@database/postgres/repositories/binding-version.repository';
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
    private readonly versions: BindingVersionRepository,
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
   *
   * Each binding is offered **at its published revision** — see
   * {@link toServedToolBindings}.
   */
  async findBindings(toolId: string): Promise<readonly ToolBinding[]> {
    if (!this.tools.has(toolId)) return [];

    const rows = await this.bindings.findByTool(toolId);
    return toServedToolBindings(rows, this.versions);
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

/**
 * `tool_bindings` rows → the domain type **as traffic is served**: at the
 * published revision, not at whatever the row holds now.
 *
 * A draft and a live binding are the same row. Editing a published binding
 * raises `mapping_version` and leaves `published_version` behind, and the
 * product rule is that calls keep being served by the published revision until
 * the provider publishes again — the publish gate (a green tester run at *this*
 * revision, payout, stake) is the only door onto the wire, and it must guard
 * every revision, not just the first. Mapping the row's current fields straight
 * through served an untested edit the moment it was saved, and a pause → edit →
 * resume did the same.
 *
 * So when the two versions differ, the versioned fields the snapshot records —
 * endpoint, both mappings, pricing mode, price, asset, timeout — and the
 * `version` a verdict cites are taken from the published `binding_versions`
 * row. The rest is the row's own and deliberately so: status, the ceilings, the
 * free-tier figures and `slaFailureRate` are outside the revision by design
 * (`VERSIONED_FIELDS` in `binding-editor.service.ts`). `settlementChains` is in
 * the revision but has no snapshot column yet, so it stays the row's; an edit
 * to it is gated at write time by the editor's enrolment and stake checks.
 *
 * One query for every drifted row, scoped per row by its own organization —
 * no new cross-tenant read. A published revision with no snapshot is a repair
 * script or a bug, and it fails closed: the binding is not offered as `ACTIVE`,
 * because the only terms left to serve are the unpublished ones.
 */
export async function toServedToolBindings(
  rows: readonly ToolBindingEntity[],
  versions: BindingVersionRepository,
): Promise<ToolBinding[]> {
  const drifted = rows.filter(hasUnpublishedRevision);
  const snapshots =
    drifted.length === 0
      ? []
      : await versions.find({
          // Only what `toServedToolBinding` reads, plus the lookup keys — not
          // the authoring and audit columns of every snapshot.
          select: {
            organizationId: true,
            bindingId: true,
            mappingVersion: true,
            endpoint: true,
            requestMapping: true,
            responseMapping: true,
            pricingMode: true,
            priceAmount: true,
            assetId: true,
            timeoutMs: true,
          },
          where: drifted.map((row) => ({
            organizationId: row.organizationId,
            bindingId: row.id,
            mappingVersion: row.publishedVersion as number,
          })),
        });

  const byRevision = new Map(
    snapshots.map((snapshot) => [
      revisionKey(snapshot.bindingId, snapshot.mappingVersion),
      snapshot,
    ]),
  );

  return rows.map((row) =>
    hasUnpublishedRevision(row)
      ? toServedToolBinding(
          row,
          byRevision.get(revisionKey(row.id, row.publishedVersion as number)) ?? null,
        )
      : toToolBinding(row),
  );
}

/**
 * `== null`, not `=== null`: this project compiles with `strictNullChecks: false`,
 * and a row built without the field must read as never-published rather than
 * as drifted.
 */
function hasUnpublishedRevision(row: ToolBindingEntity): boolean {
  return row.publishedVersion != null && row.publishedVersion !== row.mappingVersion;
}

function revisionKey(bindingId: string, mappingVersion: number): string {
  return `${bindingId}:${mappingVersion}`;
}

function toServedToolBinding(
  row: ToolBindingEntity,
  published: BindingVersionEntity | null,
): ToolBinding {
  const binding = toToolBinding(row);

  if (!published) {
    return {
      ...binding,
      status: binding.status === BindingStatus.ACTIVE ? BindingStatus.DRAFT : binding.status,
    };
  }

  return {
    ...binding,
    endpoint: published.endpoint,
    requestMapping: published.requestMapping,
    responseMapping: published.responseMapping,
    pricingMode: published.pricingMode as PricingMode,
    priceAmount: published.priceAmount,
    assetId: published.assetId as AssetId,
    timeoutMs: published.timeoutMs,
    version: published.mappingVersion,
  };
}
