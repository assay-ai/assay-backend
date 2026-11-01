import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';

import { VoucherChannelRepository } from '@database/postgres/repositories/voucher-channel.repository';
import { ProviderPayoutStagesService } from '@modules/provider/services/provider-payout-stages.service';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { RequestContext } from '@shared/observability';
import { CurrentOperator, OperatorAuthGuard, OperatorRolesGuard, RequireRoles } from '@shared/auth';

import { Override } from '../decorators/override.decorator';
import { OperatorRole } from '../domain/override-register';
import {
  ClaimUnpaidBodyDto,
  ClearReconcileBodyDto,
  DrainChannelsBodyDto,
  VerifyProviderBodyDto,
} from '../dto/operator-console.dto';
import { OperatorChannelDrainService } from '../services/operator-channel-drain.service';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { OperatorSession } from '../ports/operator-session.port';
import { OperatorProviderVerificationService } from '../services/operator-provider-verification.service';

/**
 * The provider-label surface. `V-7`.
 *
 * Same three guards, in the same order and for the same three questions, as
 * `OperatorCasesController` — see its class comment. Like every route on this
 * prefix it reads and writes across organizations by construction: the subject
 * of a verification is a provider who is never the caller, and an operator has
 * no tenant of their own.
 *
 * There is no operator screen behind this yet; it is callable by hand only.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator')
export class OperatorProvidersController {
  constructor(
    private readonly verification: OperatorProviderVerificationService,
    // The settlement panel (W2). Optional: a harness that tests verification needs neither.
    @Optional() private readonly channels?: VoucherChannelRepository,
    @Optional() private readonly stages?: ProviderPayoutStagesService,
    @Optional() private readonly drains?: OperatorChannelDrainService,
  ) {}

  /**
   * Override `M-2`: drain the payment channels — every channel with value to
   * settle gets an urgent round on the scheduler's next tick. Idempotent and
   * recorded in the override register.
   */
  @Post('channels/drain')
  @Override('M-2')
  @RequireRoles(OperatorRole.SRE, OperatorRole.TRE)
  @ApiOperation({ summary: 'Settle every pending payment channel now (one asset, or all)' })
  async drainChannels(
    @CurrentOperator() operator: OperatorSession,
    @Body() body: DrainChannelsBodyDto,
  ) {
    return this.drains!.drain(
      operator,
      {
        assetId: body.assetId ?? null,
        reasonCode: body.reasonCode,
        note: body.note,
        ticketRef: body.ticketRef ?? null,
      },
      requestIdOf(),
    );
  }

  /**
   * Override `M-3`: claim an address's unpaid channel payouts (a payout the
   * token refused, set aside by the escrow) once the issuer freeze has
   * lifted. The scheduler sends `claimUnpaid` on its next tick. Idempotent and
   * recorded in the override register.
   */
  @Post('channels/claim-unpaid')
  @Override('M-3')
  @RequireRoles(OperatorRole.SRE, OperatorRole.TRE)
  @ApiOperation({ summary: 'Claim the unpaid channel payouts of one address' })
  async claimUnpaid(
    @CurrentOperator() operator: OperatorSession,
    @Body() body: ClaimUnpaidBodyDto,
  ) {
    return this.drains!.claimUnpaid(
      operator,
      {
        assetId: body.assetId,
        address: body.address,
        reasonCode: body.reasonCode,
        note: body.note,
        ticketRef: body.ticketRef ?? null,
      },
      requestIdOf(),
    );
  }

  /**
   * The lanes the reconciler stopped (DESYNC/RECONCILE) and not cleared yet,
   * newest first, with the `channelRowId` the clear-reconcile override takes.
   * At most 200; `truncated: true` when there are more. Read only, so no override.
   */
  @Get('channels/stopped')
  @RequireRoles(OperatorRole.SRE, OperatorRole.TRE, OperatorRole.OPS_ADMIN)
  @ApiOperation({ summary: 'List the payment channels the reconciler stopped' })
  async stoppedChannels() {
    if (!this.drains) throw new NotFoundException();
    return this.drains.listStopped();
  }

  /**
   * Override `M-4`: clear a reconciler stop (DESYNC/RECONCILE) on one channel
   * after an investigation, once the chain agrees with the database again.
   * The lane goes back to ROTATED; recorded in the override register.
   */
  @Post('channels/clear-reconcile')
  @Override('M-4')
  @RequireRoles(OperatorRole.SRE, OperatorRole.TRE)
  @ApiOperation({ summary: 'Clear a reconciler stop on one payment channel' })
  async clearReconcile(
    @CurrentOperator() operator: OperatorSession,
    @Body() body: ClearReconcileBodyDto,
  ) {
    return this.drains!.clearReconcile(
      operator,
      {
        channelRowId: body.channelRowId,
        reasonCode: body.reasonCode,
        note: body.note,
        ticketRef: body.ticketRef ?? null,
      },
      requestIdOf(),
    );
  }

  /**
   * The provider's settlement rhythm (SPEC-W2 §11, API-W2 §3.7): its payout
   * cadence and next run, the last channel settle and collect, its open
   * channels and what still awaits settlement. Read only.
   */
  @Get('providers/:providerId/settlement')
  @RequireRoles(OperatorRole.SRE, OperatorRole.TRE, OperatorRole.ADJL, OperatorRole.BD)
  @ApiOperation({ summary: 'A provider’s payout cadence, next run, last settle and last collect' })
  async settlement(@Param('providerId', ParseUUIDPipe) providerId: string) {
    if (!this.channels || !this.stages) throw new NotFoundException();
    const [summary, stages] = await Promise.all([
      this.channels.providerChannelSummary(providerId),
      this.stages.stages(providerId, null),
    ]);
    return {
      providerId,
      payoutCadence: stages.payoutCadence,
      nextPayoutAt: stages.nextPayoutAt,
      lastSettleAt: summary.lastSettleAt ? summary.lastSettleAt.toISOString() : null,
      lastCollectAt: summary.lastCollectAt ? summary.lastCollectAt.toISOString() : null,
      openChannels: summary.openChannels,
      pendingSettlement: stages.awaitingSettlement,
      // Prefills the claim-unpaid override's address (frontend L-5).
      payoutAddress: summary.payoutAddress ?? null,
    };
  }

  /** `V-7` — the only writer of `providers.verified`. */
  @Post('providers/:providerId/verification')
  @Override('V-7')
  @RequireRoles(OperatorRole.ADJL, OperatorRole.BD)
  @ApiOperation({ summary: 'Set or clear a provider’s verified label' })
  @ApiResponse({ status: 404, description: 'No such provider' })
  async setVerification(
    @CurrentOperator() operator: OperatorSession,
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Body() body: VerifyProviderBodyDto,
  ) {
    return this.verification.setVerification(operator, providerId, body, requestIdOf());
  }
}

/**
 * The request id for the override row: the one this server minted for the
 * request (review L-7), never the caller's `x-request-id`, so a client cannot
 * point the entry at an unrelated trace. Log lines of the same request carry
 * it as `serverRequestId` beside the caller's `requestId`.
 */
function requestIdOf(): string | null {
  return RequestContext.getServerRequestId();
}
