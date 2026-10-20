import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CacheHeader } from '@shared/decorators/cache-header.decorator';
import { HttpCacheTTL } from '@shared/decorators/http-cache.decorator';
import { PublicReadRateLimitInterceptor } from '@shared/interceptors/public-read-rate-limit.interceptor';

import { GetPublicReservesResponseDto } from '../dto/get-public-reserves.dto';
import { PublicReservesService } from '../services/public-reserves.service';

/**
 * Proof of reserves, readable by anybody.
 *
 * ## Why there is no guard on this controller
 *
 * It is the **second** unguarded controller in the codebase, after
 * `HealthcheckController`, so the absence is worth stating rather than leaving
 * to be inferred. The page's entire claim is *"verifiable without an account"*:
 * a reader who has to authenticate to check that their custodian holds what it
 * owes is being asked to trust the custodian to answer honestly about itself,
 * which is the thing proof of reserves exists to replace.
 *
 * What makes that safe is that the payload is **platform-wide and carries no
 * tenant**: four aggregates, one vault address that is already public on chain,
 * a count, and four historical rows of the same aggregates. There is no account
 * id, no organization, no balance belonging to anyone. `PublicReservesService`
 * reads nothing keyed to a caller, and there is no caller to key it to.
 *
 * `@HttpCacheTTL(30)` because the underlying row changes every five minutes at
 * most, and an unauthenticated endpoint that hit Postgres on every request
 * would be a free amplifier. That is a *server-side* cache and 30s is well
 * inside the reconciler's own cadence.
 *
 * ## Why the browser headers are overridden
 *
 * The global default is
 * `max-age=10, stale-while-revalidate=3600, stale-if-error=3600`, and both
 * stale directives are wrong here — not merely suboptimal.
 * `stale-while-revalidate=3600` lets a browser paint an **hour-old** reserves
 * reading while it refreshes in the background, and `stale-if-error` paints one
 * when the API is down. Either would show figures as current that are not, which
 * is the precise failure `LAST_CHECK_FAILED` exists to prevent — arriving
 * through HTTP caching instead of through the reconciler, and invisible to
 * every test that reads the JSON.
 *
 * Observed, not theorised: during verification the page rendered a NORMAL
 * reading from cache for several minutes after the API had begun answering
 * `LAST_CHECK_FAILED`.
 *
 * So: 30s of freshness to match the server cache, **no** stale window, and
 * `must-revalidate`. A stale proof of reserves is worse than a slow one.
 */
@ApiTags('Public')
@UseInterceptors(PublicReadRateLimitInterceptor)
@Controller('public/reserves')
export class PublicReservesController {
  constructor(private readonly reserves: PublicReservesService) {}

  @Get()
  @HttpCacheTTL(30)
  @CacheHeader({
    maxAge: 30,
    staleWhileRevalidate: 0,
    staleIfError: 0,
    mustRevalidate: true,
  })
  @ApiOperation({
    summary: 'Vault balance against ledger liabilities, as of the last reconciliation',
    description:
      'No authentication. Returns the figures the reconciler last recorded for ' +
      'the configured asset, the fleet stake snapshot with its own timestamp, ' +
      'and recent history. Absent figures are null, never zero.',
  })
  @ApiResponse({ status: 200, type: GetPublicReservesResponseDto })
  async get(): Promise<GetPublicReservesResponseDto> {
    return this.reserves.read() as unknown as GetPublicReservesResponseDto;
  }
}
