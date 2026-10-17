import { Controller, Get, Param, Query, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CacheHeader } from '@shared/decorators/cache-header.decorator';
import { PublicReadRateLimitInterceptor } from '@shared/interceptors/public-read-rate-limit.interceptor';

import { GetCatalogueProviderParamsDto } from '../dto/get-catalogue.dto';
import { ToolVersionListDto } from '@modules/tool/dto/tool-contract-version.dto';
import { GetCatalogueToolParamsDto } from '../dto/get-catalogue.dto';
import {
  ListPublicToolsQueryDto,
  PublicProviderDetailDto,
  PublicProviderListDto,
  PublicToolListDto,
} from '../dto/public-catalogue.dto';
import { PublicCatalogueService } from '../services/public-catalogue.service';

/** Browser freshness; matches the service's in-process cache. */
const TTL_SECONDS = 30;

/**
 * The catalogue, readable without an account, for the public Explorer.
 *
 * ## Why there is no guard
 *
 * `CatalogueController` records that its answer "is identical for every
 * caller, and nothing under it is about the caller at all", and that its guard
 * stayed only because an unauthenticated catalogue was "a separate decision
 * nobody has taken". This is that decision, taken narrowly:
 *
 * - **Its own DTOs, an allowlist.** `PublicCatalogueService` copies named
 *   fields out of the signed-in catalogue, so nothing added there later leaks
 *   here. The field audit is on `dto/public-catalogue.dto.ts`.
 * - **Only listed providers.** The detail route 404s for any id the public
 *   list does not show — paused, suspended, blocked and unknown alike.
 * - **Bounded cost.** Answers are cached in process for 30 s, and each address
 *   is held to a per-minute window by `PublicReadRateLimitInterceptor`. The
 *   only input is a UUID path parameter, validated before the handler runs.
 *
 * The signed-in `/catalogue/*` is unchanged. *
 * ## Deployment: client addresses
 *
 * The per-address limit keys on `request.ip`, so `API_TRUST_PROXY_HOPS` must
 * equal the real number of proxies in front of the API (Cloudflare plus a load
 * balancer is 2). The Explorer is a static export and calls these routes from
 * each visitor's browser, so there is no shared frontend-server address.
 * A refused request gets `429` with `Retry-After`.
 */
@ApiTags('Public')
@UseInterceptors(PublicReadRateLimitInterceptor)
@Controller('public/catalogue')
export class PublicCatalogueController {
  constructor(private readonly catalogue: PublicCatalogueService) {}

  @Get('providers')
  @CacheHeader({
    maxAge: TTL_SECONDS,
    staleWhileRevalidate: 0,
    staleIfError: 0,
    mustRevalidate: true,
  })
  @ApiOperation({
    summary: 'Every provider serving traffic — no authentication',
    description: 'Providers with at least one ACTIVE binding, their stake and measured quality.',
  })
  @ApiResponse({ status: 200, type: PublicProviderListDto })
  @ApiResponse({ status: 429, description: 'Too many requests from this address.' })
  async listProviders(): Promise<PublicProviderListDto> {
    return this.catalogue.listProviders();
  }

  @Get('tools')
  @CacheHeader({
    maxAge: TTL_SECONDS,
    staleWhileRevalidate: 0,
    staleIfError: 0,
    mustRevalidate: true,
  })
  @ApiOperation({
    summary: 'Every tool at least one provider serves — no authentication',
    description:
      'Each tool with its category, tags, provider count, the market floor and the routed ' +
      'price. `?category=` keeps one topic.',
  })
  @ApiResponse({ status: 200, type: PublicToolListDto })
  @ApiResponse({ status: 400, description: 'category is not a category slug.' })
  @ApiResponse({ status: 429, description: 'Too many requests from this address.' })
  async listTools(@Query() query: ListPublicToolsQueryDto): Promise<PublicToolListDto> {
    return this.catalogue.listTools(query.category);
  }

  @Get('tools/:toolId/versions')
  @CacheHeader({
    maxAge: TTL_SECONDS,
    staleWhileRevalidate: 0,
    staleIfError: 0,
    mustRevalidate: true,
  })
  @ApiOperation({
    summary: 'A tool’s published contract versions and changelog — no authentication',
    description:
      'Newest first, with schemas, optional fields, examples, status (DEPRECATED with its ' +
      'sunset) and changelog. A draft tool is a 404.',
  })
  @ApiResponse({ status: 200, type: ToolVersionListDto })
  @ApiResponse({ status: 404, description: 'TOOL_NOT_FOUND' })
  @ApiResponse({ status: 429, description: 'Too many requests from this address.' })
  async toolVersions(@Param() params: GetCatalogueToolParamsDto): Promise<ToolVersionListDto> {
    return this.catalogue.toolVersions(params.toolId);
  }

  /** After the two literal routes, for the reason `CatalogueController` gives. */
  @Get('providers/:providerId')
  @CacheHeader({
    maxAge: TTL_SECONDS,
    staleWhileRevalidate: 0,
    staleIfError: 0,
    mustRevalidate: true,
  })
  @ApiOperation({
    summary: 'One listed provider, and what they serve — no authentication',
    description: 'Answers only for a provider `GET /public/catalogue/providers` lists.',
  })
  @ApiResponse({ status: 200, type: PublicProviderDetailDto })
  @ApiResponse({ status: 400, description: 'providerId is not a UUID.' })
  @ApiResponse({
    status: 404,
    description: 'Not a listed provider. Says nothing about whether it exists.',
  })
  @ApiResponse({ status: 429, description: 'Too many requests from this address.' })
  async getProvider(
    @Param() params: GetCatalogueProviderParamsDto,
  ): Promise<PublicProviderDetailDto> {
    return this.catalogue.getProvider(params.providerId);
  }
}
