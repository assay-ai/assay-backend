import { ToolVersionListDto } from '@modules/tool/dto/tool-contract-version.dto';
import { Injectable } from '@nestjs/common';

import { ProviderErrors } from '@modules/provider/errors/provider.errors';

import {
  CatalogueChainStakeDto,
  CatalogueMoneyDto,
  CatalogueProviderDto,
  CatalogueQualityDto,
  CatalogueToolDto,
} from '../dto/get-catalogue.dto';
import {
  PublicChainStakeDto,
  PublicMoneyDto,
  PublicProviderDetailDto,
  PublicProviderDto,
  PublicProviderListDto,
  PublicQualityDto,
  PublicToolDto,
  PublicToolListDto,
} from '../dto/public-catalogue.dto';
import { CATALOGUE_CACHE_MS, CatalogueService } from './catalogue.service';

/** How long one public catalogue answer is reused — `CatalogueService`'s window. */
export const PUBLIC_CATALOGUE_CACHE_MS = CATALOGUE_CACHE_MS;

/**
 * The catalogue as an anonymous visitor sees it.
 *
 * It reuses `CatalogueService` for every figure — one derivation of stake,
 * quality and price — and then copies an **allowlist** of fields into the
 * public DTOs. See `dto/public-catalogue.dto.ts` for the field audit.
 *
 * ## Only listed providers answer
 *
 * The signed-in detail route answers for any registered provider, including
 * one with every binding paused or one on the blocklist (with empty `tools`),
 * because a buyer reaches it from their own call history. A visitor has no
 * such history, so here the detail route answers **only for a provider the
 * public list shows** — ACTIVE, not blocked, serving at least one ACTIVE
 * binding — and every other id, registered or not, is the same 404. That
 * keeps a paused, suspended or blocked provider's existence unconfirmable, and
 * it means an unknown id costs one cached list lookup rather than a query.
 *
 * ## Cached in process — one market read per window
 *
 * The cache lives in `CatalogueService` ({@link PUBLIC_CATALOGUE_CACHE_MS}),
 * shared with the signed-in catalogue, and this class only copies fields. Every
 * provider detail is built from that one cached market read, so requesting
 * every listed id within a window costs no query beyond it. A second cache
 * here would only stack a second window of staleness on top.
 */
@Injectable()
export class PublicCatalogueService {
  constructor(private readonly catalogue: CatalogueService) {}

  async listProviders(): Promise<PublicProviderListDto> {
    const { providers } = await this.catalogue.listProviders();
    return { providers: providers.map(toPublicProvider) };
  }

  /** Every listed tool, or one category's — filtered over the same cached list. */
  async listTools(category?: string, kind?: 'STANDARD' | 'PROVIDER'): Promise<PublicToolListDto> {
    const { tools } = await this.catalogue.listTools();
    return {
      tools: tools
        .filter((tool) => category === undefined || tool.category === category)
        .filter((tool) => kind === undefined || tool.kind === kind)
        .map(toPublicTool),
    };
  }

  /** A catalogue tool's published versions and changelog. */
  async toolVersions(toolId: string): Promise<ToolVersionListDto> {
    return this.catalogue.toolVersions(toolId);
  }

  async getProvider(providerId: string): Promise<PublicProviderDetailDto> {
    // The cached list decides first, so an unlisted id is a 404 with no query.
    const { providers } = await this.catalogue.listProviders();
    if (!providers.some((provider) => provider.providerId === providerId)) {
      throw ProviderErrors.providerNotFound({ providerId });
    }

    const detail = await this.catalogue.getProvider(providerId);
    // The window may have turned between the two reads; a provider listed a
    // moment ago and unlisted now is still a 404 here, never an empty page.
    if (detail.tools.length === 0) throw ProviderErrors.providerNotFound({ providerId });
    return {
      ...toPublicProvider(detail),
      tools: detail.tools.map((tool) => ({
        toolId: tool.toolId,
        name: tool.name,
        pricingMode: tool.pricingMode,
        price: toPublicMoney(tool.price),
        freeCallsPerAgentPerDay: tool.freeCallsPerAgentPerDay,
      })),
    };
  }
}

function toPublicProvider(provider: CatalogueProviderDto): PublicProviderDto {
  return {
    providerId: provider.providerId,
    name: provider.legalName,
    verified: provider.verified,
    tier: provider.tier,
    toolIds: [...provider.toolIds],
    fromPrice: provider.fromPrice ? toPublicMoney(provider.fromPrice) : null,
    stake: provider.stake.map(toPublicStake),
    quality: provider.quality ? toPublicQuality(provider.quality) : null,
  };
}

function toPublicTool(tool: CatalogueToolDto): PublicToolDto {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    summary: tool.summary,
    version: tool.version,
    versions: tool.versions.map((version) => ({ ...version })),
    deprecatedMajors: [...tool.deprecatedMajors],
    replacementToolId: tool.replacementToolId,
    replacementName: tool.replacementName,
    replacementMajor: tool.replacementMajor,
    replacementVersion: tool.replacementVersion,
    tier: tool.tier,
    kind: tool.kind,
    handle: tool.handle,
    notReviewed: tool.notReviewed,
    category: tool.category,
    tags: [...tool.tags],
    providerCount: tool.providerCount,
    fromPrice: tool.fromPrice ? toPublicMoney(tool.fromPrice) : null,
    price: tool.price ? toPublicMoney(tool.price) : null,
    pricingMode: tool.pricingMode,
    freeCallsPerDay: tool.freeCallsPerDay,
    paidBindings: tool.paidBindings,
    routable: tool.routable,
    settlementChains: tool.settlementChains ? [...tool.settlementChains] : null,
  };
}

function toPublicMoney(money: CatalogueMoneyDto): PublicMoneyDto {
  return { amount: money.amount, asset: money.asset, decimals: money.decimals };
}

function toPublicStake(stake: CatalogueChainStakeDto): PublicChainStakeDto {
  return {
    chainId: stake.chainId,
    amount: stake.amount,
    asset: stake.asset,
    decimals: stake.decimals,
  };
}

function toPublicQuality(quality: CatalogueQualityDto): PublicQualityDto {
  return {
    rate: quality.rate,
    measuredCalls: quality.measuredCalls,
    failedCalls: quality.failedCalls,
  };
}
