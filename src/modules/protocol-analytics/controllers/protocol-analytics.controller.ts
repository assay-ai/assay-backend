import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { NoCacheHeader } from '@shared/decorators/cache-header.decorator';
import { PublicReadRateLimitInterceptor } from '@shared/interceptors/public-read-rate-limit.interceptor';

import {
  ProtocolAnalyticsQueryDto,
  ProtocolAnalyticsResponseDto,
} from '../dto/protocol-analytics.dto';
import { ProtocolAnalyticsService } from '../services/protocol-analytics.service';

@ApiTags('Public')
@UseInterceptors(PublicReadRateLimitInterceptor)
@Controller('public/analytics')
export class ProtocolAnalyticsController {
  constructor(private readonly analytics: ProtocolAnalyticsService) {}

  @Get()
  @NoCacheHeader()
  @ApiOperation({
    summary: 'Protocol payment analytics, one asset at a time',
    description:
      'Five-minute Redis snapshots; browser and CDN caching disabled. Funded PAID calls only. Money is atomic-unit strings. Recent payments are daily tool groups, never wallet activity. All-time totals with a bounded 90-day chart.',
  })
  @ApiResponse({ status: 200, type: ProtocolAnalyticsResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid range or disabled asset.' })
  @ApiResponse({ status: 429, description: 'Public read limit exceeded.' })
  get(@Query() query: ProtocolAnalyticsQueryDto): Promise<ProtocolAnalyticsResponseDto> {
    return this.analytics.read(query);
  }
}
