import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { platformAssetFrom } from '@modules/chains/platform-asset';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { BindingStatus, PricingMode, Tool } from '@modules/tool/ports/tool.types';
import { CursorPageDto, ListSpec, asInstant, paginate } from '@shared/api';

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
  constructor(
    private readonly bindings: ToolBindingRepository,
    @Inject(TOOL_CATALOGUE) private readonly catalogue: ToolCataloguePort,
    private readonly config: ConfigService,
  ) {}

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

    return toDetailDto(row);
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
  async getCatalogue(): Promise<ToolCatalogueDto> {
    const tools = await this.catalogue.listTools();

    const metadata = getAssetMetadata(settlementAsset(this.config));

    return {
      tools: tools.map(toCatalogueToolDto),
      settlementAsset: {
        assetId: metadata.assetId,
        symbol: metadata.symbol,
        decimals: metadata.decimals,
      },
    };
  }
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
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    tier: tool.tier,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
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
export function toDetailDto(row: ToolBindingEntity): ToolBindingDetailDto {
  return {
    ...toSummaryDto(row),
    requestMapping: row.requestMapping,
    responseMapping: row.responseMapping,
    freeQuotaPerAgent: row.freeQuotaPerAgent,
    freeDailyBudget: row.freeDailyBudget === null ? null : Number(row.freeDailyBudget),
    slaFailureRate: Number(row.slaFailureRate),
    timeoutMs: row.timeoutMs,
    maxRps: row.maxRps,
    maxDailyCalls: row.maxDailyCalls,
    publishedVersion: row.publishedVersion,
    // `null !== 1` is `true`, and that is the answer wanted: a binding that has
    // never been published is wholly unpublished.
    hasUnpublishedChanges: row.publishedVersion !== row.mappingVersion,
  };
}
