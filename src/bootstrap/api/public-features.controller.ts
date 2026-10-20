import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CacheHeader, PUBLIC_EDGE_CACHE } from '@shared/decorators/cache-header.decorator';
import { PublicReadRateLimitInterceptor } from '@shared/interceptors/public-read-rate-limit.interceptor';
import { isPublicDemoConfigured } from '@modules/mcp/mcp-api.module';
import { isPublicReservesConfigured } from '@modules/settlement/public-reserves-api.module';

export class PublicFeaturesResponseDto {
  @ApiProperty({ description: 'Whether `GET /public/reserves` is registered' })
  reserves: boolean;

  @ApiProperty({ description: 'Whether the `/public/demo/*` routes are registered' })
  demo: boolean;
}

/**
 * Which optional public pages this deployment serves.
 *
 * `/public/reserves` and `/public/demo/*` are registered only when configured,
 * and the pages used to find that out by calling them and reading the 404.
 * This route is always registered, so a page asks here first and never calls
 * a route that does not exist. It answers from the same two predicates the
 * bootstrap mounts those modules with, so the two cannot disagree.
 *
 * Unguarded on purpose: two booleans about the deployment, no tenant, and the
 * pages that read it have no session.
 *
 * The Explorer's routes — `/public/catalogue/*` and `/public/not-charged` — are
 * deliberately **not** listed: they need no configuration and are registered
 * on every deployment, so there is nothing for a page to ask. A flag that is
 * always `true` would only invite a page to branch on it.
 */
@ApiTags('Public')
@UseInterceptors(PublicReadRateLimitInterceptor)
@Controller('public/features')
export class PublicFeaturesController {
  @Get()
  @CacheHeader({
    maxAge: 60,
    staleWhileRevalidate: 0,
    staleIfError: 0,
    mustRevalidate: true,
    ...PUBLIC_EDGE_CACHE,
  })
  @ApiOperation({ summary: 'Which optional public pages this deployment serves' })
  @ApiResponse({ status: 200, type: PublicFeaturesResponseDto })
  get(): PublicFeaturesResponseDto {
    return { reserves: isPublicReservesConfigured(), demo: isPublicDemoConfigured() };
  }
}
