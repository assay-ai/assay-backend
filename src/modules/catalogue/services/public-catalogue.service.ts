import { Injectable } from '@nestjs/common';

import { ProviderErrors } from '@modules/provider/errors/provider.errors';

import { TtlCache } from '../domain/ttl-cache';
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
import { CatalogueService } from './catalogue.service';

/** How long one public catalogue answer is reused. */
export const PUBLIC_CATALOGUE_CACHE_MS = 30_000;

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
 * ## Cached in process
 *
 * {@link PUBLIC_CATALOGUE_CACHE_MS}, per answer. Detail entries are keyed by
 * ids the list already contains, so the cache is bounded by the market size.
 */
@Injectable()
export class PublicCatalogueService {
  private readonly providerList = new TtlCache<PublicProviderListDto>(PUBLIC_CATALOGUE_CACHE_MS);
  private readonly toolList = new TtlCache<PublicToolListDto>(PUBLIC_CATALOGUE_CACHE_MS);
  private readonly providerDetail = new TtlCache<PublicProviderDetailDto>(
    PUBLIC_CATALOGUE_CACHE_MS,
  );

  constructor(private readonly catalogue: CatalogueService) {}

  listProviders(): Promise<PublicProviderListDto> {
    return this.providerList.get('all', async () => {
      const { providers } = await this.catalogue.listProviders();
      return { providers: providers.map(toPublicProvider) };
    });
  }

  listTools(): Promise<PublicToolListDto> {
    return this.toolList.get('all', async () => {
      const { tools } = await this.catalogue.listTools();
      return { tools: tools.map(toPublicTool) };
    });
  }

  async getProvider(providerId: string): Promise<PublicProviderDetailDto> {
    const { providers } = await this.listProviders();
    if (!providers.some((provider) => provider.providerId === providerId)) {
      throw ProviderErrors.providerNotFound({ providerId });
    }

    return this.providerDetail.get(providerId, async () => {
      const detail = await this.catalogue.getProvider(providerId);
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
    });
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
    tier: tool.tier,
    providerCount: tool.providerCount,
    fromPrice: tool.fromPrice ? toPublicMoney(tool.fromPrice) : null,
    price: tool.price ? toPublicMoney(tool.price) : null,
    pricingMode: tool.pricingMode,
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
