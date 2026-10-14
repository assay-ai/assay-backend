import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { NoCacheHeader } from '@shared/decorators/cache-header.decorator';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { GetProviderCallsExportQueryDto } from '../dto/get-provider-calls-export.dto';
import {
  GetProviderEarningsQueryDto,
  GetProviderEarningsResponseDto,
} from '../dto/get-provider-earnings.dto';
import { GetProviderMeResponseDto } from '../dto/get-provider-me.dto';
import {
  GetProviderQualityQueryDto,
  GetProviderQualityResponseDto,
} from '../dto/get-provider-quality.dto';
import { GetProviderStakeResponseDto } from '../dto/get-provider-stake.dto';
import {
  GetProviderTrafficQueryDto,
  GetProviderTrafficResponseDto,
} from '../dto/get-provider-traffic.dto';
import {
  ProviderCallsExportService,
  writeExportCsv,
} from '../services/provider-calls-export.service';
import { ProviderEarningsService } from '../services/provider-earnings.service';
import { ProviderProfileService } from '../services/provider-profile.service';
import { ProviderQualityService } from '../services/provider-quality.service';
import { ProviderStakeService } from '../services/provider-stake.service';
import { ProviderTrafficService } from '../services/provider-traffic.service';

/**
 * `GET /api/v1/providers/me` and its report sub-resources.
 *
 * `organizationId` comes from `@CurrentSession()` and nowhere else — see
 * `SessionAuthGuard`. Every service here reads it as the provider's own id;
 * see `ProviderProfileService` for why that identification is the module's
 * core, load-bearing assumption.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('providers/me')
export class ProviderController {
  constructor(
    private readonly profile: ProviderProfileService,
    private readonly traffic: ProviderTrafficService,
    private readonly quality: ProviderQualityService,
    private readonly earnings: ProviderEarningsService,
    private readonly stake: ProviderStakeService,
    private readonly callsExport: ProviderCallsExportService,
  ) {}

  @Get()
  @ApiOperation({ summary: "The calling organization's provider record: id, status, tier, stats" })
  @ApiResponse({ status: 200, type: GetProviderMeResponseDto })
  @ApiResponse({ status: 404, description: 'This organization has no provider record' })
  async getMe(@CurrentSession() session: McpSession): Promise<GetProviderMeResponseDto> {
    return this.profile.getMe(session.organizationId);
  }

  @Get('traffic')
  @ApiOperation({
    summary:
      'Call volume over a window, bucketed by UTC calendar day, plus a per-agent breakdown ' +
      'and an optional `agentId` filter',
  })
  @ApiResponse({ status: 200, type: GetProviderTrafficResponseDto })
  async getTraffic(
    @CurrentSession() session: McpSession,
    @Query() query: GetProviderTrafficQueryDto,
  ): Promise<GetProviderTrafficResponseDto> {
    return this.traffic.getTraffic(session.organizationId, query);
  }

  @Get('quality')
  @ApiOperation({ summary: 'Quality position: paid vs free pass rate, availability, verdict mix' })
  @ApiResponse({ status: 200, type: GetProviderQualityResponseDto })
  async getQuality(
    @CurrentSession() session: McpSession,
    @Query() query: GetProviderQualityQueryDto,
  ): Promise<GetProviderQualityResponseDto> {
    return this.quality.getQuality(session.organizationId, query);
  }

  @Get('earnings')
  @ApiOperation({ summary: 'Earned vs platform fee vs withheld, grouped by day or by tool' })
  @ApiResponse({ status: 200, type: GetProviderEarningsResponseDto })
  async getEarnings(
    @CurrentSession() session: McpSession,
    @Query() query: GetProviderEarningsQueryDto,
  ): Promise<GetProviderEarningsResponseDto> {
    return this.earnings.getEarnings(session.organizationId, query);
  }

  @Get('stake')
  @ApiOperation({
    summary:
      'Capital: stake, unbonding, on-chain exposure, the requirement itemised per ' +
      'binding with its grace period, headroom and the recommended buffer',
  })
  @ApiResponse({ status: 200, type: GetProviderStakeResponseDto })
  async getStake(@CurrentSession() session: McpSession): Promise<GetProviderStakeResponseDto> {
    return this.stake.getStake(session.organizationId);
  }

  /**
   * `GET /providers/me/calls/export` — one CSV row per call.
   *
   * `@Res()` without `passthrough`, matching `McpController.handle`'s own
   * doc comment on the same technique: taking the response over directly is
   * what lets this stream a CSV body instead of going through
   * `TransformInterceptor`'s `{ data, statusCode, message }` envelope, which
   * cannot wrap a file and stay a valid CSV. See
   * `ProviderCallsExportService`'s doc comment for why this endpoint is not a
   * `CursorPageDto` list in the first place.
   *
   * ## Why `@NoCacheHeader()` is load-bearing here and nowhere else
   *
   * `CacheHeaderInterceptor` sets its headers in a `tap` on the response
   * observable — *after* the handler has run. Every other route in this
   * controller returns a value and lets Nest send it, so the `tap` still
   * precedes the write. This one takes the socket over with `@Res()` and
   * calls `res.end()` itself, so by the time the `tap` fires the response has
   * already gone out and `setHeader` is a no-op. Measured, not assumed: the
   * endpoint shipped with **no `Cache-Control`, no `CDN-Cache-Control` and no
   * `Vary` at all**, while an ordinary handler on the same interceptor got
   * `private` + `no-store` + `Vary: Authorization`.
   *
   * `@NoCacheHeader()` is the one path in that interceptor which runs *before*
   * `next.handle()`, so it is the only one a `@Res()` route can use. It is
   * also the correct answer on the merits: this is one provider's complete
   * per-call financial history, the highest-value cross-tenant leak on the
   * provider surface, and the platform already paid for that lesson once when
   * an HTTP cache served org A's verdict to org B. The interceptor's own comment
   * refuses to rest a tenant boundary on an intermediary honouring `private`
   * — silence is not a refusal, and this route was silent.
   */
  @NoCacheHeader()
  @Get('calls/export')
  @ApiOperation({ summary: 'CSV export of every call served, one row per call, for a time window' })
  @ApiProduces('text/csv')
  @ApiResponse({ status: 200, description: 'A CSV file — see `ProviderCallsExportService`' })
  async exportCalls(
    @CurrentSession() session: McpSession,
    @Query() query: GetProviderCallsExportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.callsExport.prepare(session.organizationId, query);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="calls-${query.from}_${query.to}.csv"`,
    );
    // Visible-cap headers — `docs/api-list-contract.md`'s no-silent-caps
    // principle, applied to a response shape the JSON envelope cannot carry
    // it in. Set before the first byte, since a header cannot follow a body.
    res.setHeader('X-Assay-Export-Total-Matching', String(result.meta.totalMatching));
    res.setHeader('X-Assay-Export-Row-Count', String(result.meta.rowCount));
    res.setHeader('X-Assay-Export-Truncated', String(result.meta.truncated));

    await writeExportCsv(result, (chunk) => res.write(chunk));
    res.end();
  }
}
