import { ToolContractVersionDto } from '@modules/tool/dto/tool-contract-version.dto';
import {
  contractVersionsOf,
  currentContractVersion,
} from '@modules/tool/domain/contract/contract-versions';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { BindingTestRunEntity } from '@database/postgres/entities/binding-test-run.entity';
import { BindingVersionEntity } from '@database/postgres/entities/binding-version.entity';
import { BindingVersionRepository } from '@database/postgres/repositories/binding-version.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { AssetId, chainIdOf } from '@modules/chains/ports/caip.types';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { platformAssetFrom } from '@modules/chains/platform-asset';
import {
  minPaidPriceFor,
  PAID_PRICE_FLOOR_FROM_ENV,
} from '@modules/payment/domain/paid-price-floor';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import {
  BindingAuthMode,
  BindingStatus,
  PricingMode,
  Tool,
  isListedTool,
  isProviderTool,
} from '@modules/tool/ports/tool.types';
import { CursorPageDto, ListSpec, asInstant, paginate } from '@shared/api';
import { AuditActor, AuditLogWriter } from '@shared/audit';

import { originOf } from '../credentials/credential-rules';
import { CredentialVaultService } from '../credentials/credential-vault.service';

import {
  ListToolBindingsQueryDto,
  ToolBindingDetailDto,
  ToolBindingSummaryDto,
} from '../dto/get-tool-bindings.dto';
import { CatalogueToolDto, ToolCatalogueDto } from '../dto/get-tool-catalogue.dto';
import { ProviderErrors } from '../errors/provider.errors';

/**
 * Sorted by `createdAt` — the platform default, available at last.
 *
 * This list originally sorted by `id`, because the in-memory `ToolBinding`
 * type had no timestamp, because it had no table. The `tool_bindings` table
 * gives it one, so the odd one out rejoins the convention every other
 * list endpoint follows.
 */
const TOOL_BINDING_LIST: ListSpec = {
  alias: 'binding',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'binding.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: ToolBindingEntity) => row.createdAt),
    },
  },
};

/**
 * `GET /providers/me/tool-bindings` and `/:id` — the binding editor, overview
 * and portfolio.
 *
 * These were originally served by walking every tool in the catalogue and
 * filtering bindings by `providerId` in memory, because `ToolCataloguePort` has
 * no "bindings for this provider" query and there was no table to ask instead.
 * That stopped being acceptable once a real table existed, so it is one now: a
 * scoped read against `tool_bindings`, keyset-paginated, with no cross-tenant
 * walk in it at all.
 */
@Injectable()
export class ProviderToolBindingsService {
  private readonly logger = new Logger(ProviderToolBindingsService.name);

  constructor(
    private readonly bindings: ToolBindingRepository,
    @Inject(TOOL_CATALOGUE) private readonly catalogue: ToolCataloguePort,
    private readonly config: ConfigService,
    private readonly versions: BindingVersionRepository,
    // `discardDraft` only: one transaction, the vault's own prune, and the
    // audit entry written inside it (no deletion without its entry).
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    private readonly vault: CredentialVaultService,
    private readonly audit: AuditLogWriter,
  ) {}

  /**
   * `DELETE /providers/me/tool-bindings/:id` — discard a draft.
   *
   * Only a binding that never left the draft: status `DRAFT`, never published
   * (`published_version` and `published_at` both null), and named by **no**
   * row outside the draft — no call, attempt, payment, dispute, check window,
   * strike, penalty, stake grace or traffic statistic ({@link EVIDENCE}).
   * Those rows are evidence about traffic, and several of them would cascade
   * away with the binding. Anything else is `PROVIDER_BINDING_NOT_DISCARDABLE`
   * (409): pause a published binding instead.
   *
   * What it deletes, in one transaction, with the binding row locked first so
   * a publish cannot race it:
   *  - the binding's credential sets, through the vault's own `pruneExcept`
   *    with nothing kept (names are audited, never values);
   *  - its tester runs and its draft revision snapshots (`binding_test_runs`,
   *    `binding_versions`): a never-published revision is cited by no verdict;
   *  - the `tool_bindings` row;
   *  - and it writes one `tool_binding.discarded` audit entry in the same
   *    transaction.
   *
   * Another organization's id is a 404, never a 409: the refusal must not
   * confirm that someone else's binding exists.
   */
  async discardDraft(organizationId: string, actor: AuditActor, bindingId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const row = await manager.findOne(ToolBindingEntity, {
        where: { organizationId, id: bindingId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw ProviderErrors.bindingNotFound({ bindingId });

      const reason = await discardRefusal(manager, row);
      if (reason) throw ProviderErrors.bindingNotDiscardable({ bindingId, reason });

      const pruned = await this.vault.pruneExcept(manager, organizationId, bindingId, []);
      const runs = await manager.delete(BindingTestRunEntity, { organizationId, bindingId });
      const revisions = await manager.delete(BindingVersionEntity, { organizationId, bindingId });
      const removed = await manager.delete(ToolBindingEntity, { organizationId, id: bindingId });
      if (removed.affected !== 1) throw ProviderErrors.bindingNotFound({ bindingId });

      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'tool_binding.discarded',
        resourceType: 'tool_binding',
        resourceId: bindingId,
        before: {
          tool_id: row.toolId,
          // The origin only, as every binding audit records it: a stored URL
          // may carry userinfo, a path or a query nobody should keep forever.
          endpoint_origin: safeOrigin(row.endpoint),
          status: row.status,
          mapping_version: row.mappingVersion,
          test_runs: runs.affected ?? 0,
          revisions: revisions.affected ?? 0,
          credential_sets: pruned.map(({ origin, headerNames }) => ({
            origin,
            header_names: headerNames,
          })),
        },
      });
    });
    this.logger.log(`Draft binding ${bindingId} discarded`);
  }

  async listBindings(
    providerId: string,
    query: ListToolBindingsQueryDto,
  ): Promise<CursorPageDto<ToolBindingSummaryDto>> {
    const qb = this.bindings
      .createQueryBuilder('binding')
      .where('binding.organizationId = :organizationId', { organizationId: providerId });

    const page = await paginate(qb, query, TOOL_BINDING_LIST);
    return page.map(toSummaryDto);
  }

  async getBinding(providerId: string, bindingId: string): Promise<ToolBindingDetailDto> {
    const row = await this.bindings.findOne({
      where: { organizationId: providerId, id: bindingId },
    });

    if (!row) {
      throw ProviderErrors.bindingNotFound({ bindingId });
    }

    return toDetailDto(row, await publishedEndpointOf(this.versions, row));
  }

  /**
   * The tools a provider may bind, and the asset a binding must be priced in.
   *
   * Takes **no organization**: the catalogue is the platform's, identical for
   * everyone, and a provider id in this signature would imply a per-tenant view
   * that does not exist. See `get-tool-catalogue.dto.ts` for why the console
   * cannot author a binding without it.
   *
   * **Unpaged, deliberately** — `listTools()` is unpaged, its own doc comment
   * records why (24 tools at launch, and a cursor with nothing behind it is an
   * API that changes twice), and this endpoint inherits that decision rather
   * than inventing a second answer to it.
   */
  async getCatalogue(organizationId?: string): Promise<ToolCatalogueDto> {
    // Every LISTED standard tool, and the caller's own provider tools: a
    // provider tool's own binding is its only implementation (§7.6), so
    // nobody else's provider tool is bindable — or named here.
    const tools = (await this.catalogue.listTools()).filter((tool) =>
      canBind(tool, organizationId),
    );

    const metadata = getAssetMetadata(settlementAsset(this.config));

    return {
      tools: tools.map(toCatalogueToolDto),
      settlementAsset: {
        assetId: metadata.assetId,
        chainId: chainIdOf(metadata.assetId),
        symbol: metadata.symbol,
        decimals: metadata.decimals,
        // The same function the editor and admission enforce, for this caller:
        // an exempt provider is told `'0'`.
        minPaidPrice: minPaidPriceFor(
          PAID_PRICE_FLOOR_FROM_ENV,
          organizationId ?? null,
          metadata.decimals,
        ).toString(),
      },
    };
  }
}

/**
 * Tables whose rows are evidence about a binding's traffic. A row in any of
 * them means the binding is more than a draft, whatever its status says.
 * `sla_windows`, `sla_strikes` and `provider_stake_grace` would even cascade
 * away with the binding.
 */
export const EVIDENCE: ReadonlyArray<{ table: string; what: string }> = [
  { table: 'tool_call_records', what: 'has calls' },
  { table: 'binding_attempts', what: 'has calls' },
  { table: 'binding_stats', what: 'has calls' },
  { table: 'payment_intents', what: 'has payments' },
  { table: 'disputes', what: 'has disputes' },
  { table: 'sla_windows', what: 'has check windows' },
  { table: 'sla_strikes', what: 'has check windows' },
  { table: 'slash_proposals', what: 'has penalties' },
  { table: 'provider_stake_grace', what: 'has a stake grace period' },
];

/** Notices about a binding (stake headroom, check windows): no FK, so checked by subject. */
const NOTICE_EVIDENCE = { what: 'has notices about it' };

/** `originOf`, or null for an address that does not parse (never the raw string). */
function safeOrigin(endpoint: string): string | null {
  try {
    return originOf(endpoint);
  } catch {
    return null;
  }
}

/** Why `row` is not a discardable draft, or null when it is. */
async function discardRefusal(
  manager: EntityManager,
  row: ToolBindingEntity,
): Promise<string | null> {
  if (row.status !== BindingStatus.DRAFT) return `is ${row.status}`;
  if (row.publishedVersion !== null || row.publishedAt !== null) return 'was published';
  // Table names are the constant list above, never input.
  const checks = EVIDENCE.map(
    ({ table }, index) =>
      `EXISTS (SELECT 1 FROM "${table}" WHERE "binding_id" = $1) AS "e${index}"`,
  ).join(', ');
  const [found] = (await manager.query(`SELECT ${checks}`, [row.id])) as Array<
    Record<string, boolean>
  >;
  const hit = EVIDENCE.find((_, index) => found?.[`e${index}`]);
  if (hit) return hit.what;
  const [notice] = (await manager.query(
    `SELECT EXISTS (SELECT 1 FROM "notifications"
       WHERE "subject_type" = 'binding' AND "subject_id" = $1::text) AS "e"`,
    [row.id],
  )) as Array<{ e: boolean }>;
  return notice?.e ? NOTICE_EVIDENCE.what : null;
}

/**
 * The asset this deployment prices and settles in.
 *
 * The value and the default are `ProviderStakeService`'s and
 * `loadPayoutThresholdParameters`' — one asset per deployment, named by one
 * variable — but the emptiness guard is new, and it is here rather than there
 * because of where the value lands. Both of those hand it to
 * `MoneyUtil.of(..., asset, 6)`, which is given its decimals and never consults
 * the registry, and both run once as a `useFactory` at boot; an empty or bogus
 * id boots fine and shows up later as a mislabelled amount. **This is the first
 * call site that reaches `getAssetMetadata`, and it does so per request** —
 * where an unregistered id is `CHAIN_ASSET_UNKNOWN` at `statusCode: 400`. On a
 * read that carries no input, that would tell a provider console it sent a bad
 * asset on a request where it sent no asset at all: an operator's
 * misconfiguration reported as the caller's error.
 *
 * `??` alone does not cover it. It falls back on `null`/`undefined` only, and
 * `PLATFORM_STAKE_ASSET_ID=` — an empty string, which is precisely how the
 * variable arrives in a `.env` copied from `.env.example` and not filled in —
 * is neither. So empty is normalised to unset, the same guard and the same
 * hazard `provider.module.ts`'s `positiveMs` writes down for its own env vars.
 *
 * A **wrong** id is deliberately not normalised: an operator who points this at
 * a mint the registry has never heard of should find out, and the 400 is how.
 */
function settlementAsset(config: ConfigService): AssetId {
  // The empty-is-unset guard and the default now live in `platformAssetFrom`,
  // shared with the stake floor so the two cannot name different assets.
  return platformAssetFrom(config);
}

/**
 * The two schemas are passed through by reference, not rebuilt.
 *
 * They are the contract the mapping is checked against at Save, and the
 * document the editor draws its columns from. Copying them field by field would
 * be a second, hand-maintained description of a JSON Schema — the one thing
 * that must not be allowed to drift from the catalogue's own copy.
 */
function toCatalogueToolDto(tool: Tool): CatalogueToolDto {
  const current = currentContractVersion(tool);
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    tier: tool.tier,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    currentVersion: current?.semver ?? null,
    versions: contractVersionsOf(tool).map((version) =>
      ToolContractVersionDto.of(version, tool.currentVersion ?? current?.version),
    ),
  };
}

function toSummaryDto(row: ToolBindingEntity): ToolBindingSummaryDto {
  const decimals = getAssetMetadata(row.assetId as AssetId).decimals;
  return {
    id: row.id,
    toolId: row.toolId,
    endpoint: row.endpoint,
    pricingMode: row.pricingMode as PricingMode,
    price: { amount: row.priceAmount, asset: row.assetId, decimals },
    // Copied off the row, not derived from `price.asset`. The two disagree by
    // design the moment a binding is offered on a chain it is not priced in,
    // and deriving here would hide exactly that case.
    settlementChains: row.settlementChains,
    status: row.status as BindingStatus,
    version: row.mappingVersion,
  };
}

/**
 * The one mapper from a `tool_bindings` row to the detail shape.
 *
 * Exported because `binding-editor.service.ts` returns the same shape from
 * `POST` and `PATCH` and used to compute `hasUnpublishedChanges` a second time
 * to do it. Two mappers answering one question is how the read and the write
 * end up disagreeing about whether a provider has unpublished edits.
 */
export function toDetailDto(
  row: ToolBindingEntity,
  publishedEndpoint: string | null,
): ToolBindingDetailDto {
  return {
    ...toSummaryDto(row),
    publishedEndpoint,
    authMode: row.authMode as BindingAuthMode,
    requestMapping: row.requestMapping,
    responseMapping: row.responseMapping,
    freeQuotaPerAgent: row.freeQuotaPerAgent,
    freeDailyBudget: row.freeDailyBudget === null ? null : Number(row.freeDailyBudget),
    slaFailureRate: Number(row.slaFailureRate),
    timeoutMs: row.timeoutMs,
    maxRps: row.maxRps,
    maxDailyCalls: row.maxDailyCalls,
    publishedVersion: row.publishedVersion,
    toolVersionRange: row.toolVersionRange ?? '^1',
    providesOutputFields: [...(row.providesOutputFields ?? [])],
    supportsInputFields: [...(row.supportsInputFields ?? [])],
    // `null !== 1` is `true`, and that is the answer wanted: a binding that has
    // never been published is wholly unpublished.
    hasUnpublishedChanges: row.publishedVersion !== row.mappingVersion,
  };
}

/**
 * Whether `organizationId` may bind `tool`: a LISTED standard tool, or one of
 * its own provider tools (§7.6: "the provider's own binding is the only
 * implementation").
 */
export function canBind(tool: Tool, organizationId: string | null | undefined): boolean {
  if (isProviderTool(tool)) return !!organizationId && tool.ownerOrgId === organizationId;
  return isListedTool(tool);
}

/** The endpoint stored in the revision currently published, or null when never published. */
export async function publishedEndpointOf(
  versions: Pick<BindingVersionRepository, 'findOne'>,
  row: Pick<ToolBindingEntity, 'organizationId' | 'id' | 'publishedVersion'>,
): Promise<string | null> {
  if (row.publishedVersion === null || row.publishedVersion === undefined) return null;
  const published = await versions.findOne({
    where: {
      organizationId: row.organizationId,
      bindingId: row.id,
      mappingVersion: row.publishedVersion,
    },
  });
  return published?.endpoint ?? null;
}
