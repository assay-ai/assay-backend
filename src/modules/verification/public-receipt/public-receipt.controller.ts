import { Controller, Get, Header, Param, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CacheHeader } from '@shared/decorators/cache-header.decorator';
import { PublicReadRateLimitInterceptor } from '@shared/interceptors/public-read-rate-limit.interceptor';

import { PublicReceiptResponseDto } from './public-receipt.dto';
import { PublicReceiptService } from './public-receipt.service';

/**
 * One paid call's public receipt, readable by anybody who has the call's id.
 *
 * ## No guard, on purpose, and what that makes this route
 *
 * It reads across organizations by a random v4 id (122 bits), so it cannot be
 * walked, and there is no list, search or "by buyer" form of it. It shows what
 * `PublicReceiptResponseDto` names and nothing else: no parameters, no result,
 * no wallet, no transaction, no buyer, no verifier text. A buyer can switch
 * their organization's receipts off (the route then answers 404).
 *
 * The demo verdict route shipped once as an HTTP cache leak across tenants, so
 * this route has its own path, a 30 s edge cache keyed by the whole URL, and
 * every authenticated receipt route is `no-store` (tested).
 */
@ApiTags('Public')
@UseInterceptors(PublicReadRateLimitInterceptor)
@Controller('public/receipts')
export class PublicReceiptsController {
  constructor(private readonly receipts: PublicReceiptService) {}

  @Get(':intentId')
  @CacheHeader({
    maxAge: 30,
    staleWhileRevalidate: 0,
    staleIfError: 0,
    mustRevalidate: true,
    cdnMaxAge: 30,
    cdnStaleWhileRevalidate: 0,
    cdnStaleIfError: 0,
  })
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Header('Referrer-Policy', 'no-referrer')
  @ApiOperation({
    summary: 'One paid call, for anyone with its id — no authentication',
    description:
      'Public and minimal: tool and provider (when listed), listed and charged price, whether it was charged, the four check stages as passed/failed, and times rounded to the minute. No parameters, results, wallets, transactions or buyer identifiers.',
  })
  @ApiResponse({ status: 200, type: PublicReceiptResponseDto })
  @ApiResponse({ status: 404, description: 'No such receipt, or its owner hides receipts.' })
  async get(@Param('intentId') intentId: string): Promise<PublicReceiptResponseDto> {
    return this.receipts.read(intentId);
  }
}
