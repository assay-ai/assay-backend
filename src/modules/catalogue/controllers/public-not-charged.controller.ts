import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CacheHeader, PUBLIC_EDGE_CACHE } from '@shared/decorators/cache-header.decorator';
import { PublicReadRateLimitInterceptor } from '@shared/interceptors/public-read-rate-limit.interceptor';

import { PublicNotChargedResponseDto } from '../dto/get-public-not-charged.dto';
import { PublicNotChargedService } from '../services/public-not-charged.service';

/**
 * Recent paid calls the platform did not charge for, readable by anybody.
 *
 * ## Why there is no guard
 *
 * The Explorer's claim is *"you don't pay for results you can't use"*, made to
 * a visitor who has no account yet — asking them to sign up before showing the
 * evidence would ask them to trust the claim first. The payload is
 * platform-wide and names no buyer: tool, provider name, listed price, a
 * reason, and the UTC day. `PublicNotChargedService` documents the projection,
 * and the repository never selects an identifier to begin with.
 *
 * Rows (the call and its outcome) are at least 24 h old and dated to the UTC day; each tool's published
 * rows come from at least five distinct established buyers; totals cover
 * complete UTC days. The full rule is on `PublicNotChargedService`.
 *
 * Cached in process for 60 s by the service, held to a per-address window by
 * `PublicReadRateLimitInterceptor`, and takes no input at all. *
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
@Controller('public/not-charged')
export class PublicNotChargedController {
  constructor(private readonly notCharged: PublicNotChargedService) {}

  @Get()
  @CacheHeader({
    maxAge: 60,
    staleWhileRevalidate: 0,
    staleIfError: 0,
    mustRevalidate: true,
    ...PUBLIC_EDGE_CACHE,
  })
  @ApiOperation({
    summary: 'Recent paid calls that were not charged, and 30-day totals — no authentication',
    description:
      'Platform-wide and anonymised: tool, provider name, listed price, reason and the UTC day ' +
      'of the call (rows whose call and outcome are at least 24 h old). No buyer, organization, agent, call or transaction identifiers. A tool is ' +
      'listed only when at least `minBuyers` different buyers had calls not charged on it.',
  })
  @ApiResponse({ status: 200, type: PublicNotChargedResponseDto })
  @ApiResponse({ status: 429, description: 'Too many requests from this address.' })
  async get(): Promise<PublicNotChargedResponseDto> {
    return this.notCharged.read();
  }
}
