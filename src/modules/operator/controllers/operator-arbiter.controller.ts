import { Body, Controller, Get, HttpCode, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { SlashContractCallDto } from '@modules/slash/dto/slash-dispute-intent.dto';
import { SlashContractCall } from '@modules/slash/ports/slash-dispute-intent.port';
import { SlashDisputeIntentService } from '@modules/slash/services/slash-dispute-intent.service';
import { RequestContext } from '@shared/observability';
import { CurrentOperator, OperatorAuthGuard, OperatorRolesGuard, RequireRoles } from '@shared/auth';

import { Override } from '../decorators/override.decorator';
import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import { OperatorRole } from '../domain/override-register';
import {
  ArbiterBlockBodyDto,
  ArbiterRulingBodyDto,
  ArbiterTermsQueryDto,
} from '../dto/operator-console.dto';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { OperatorSession } from '../ports/operator-session.port';
import { isApprovalQueued } from '../services/operator-approval.service';
import { OperatorArbiterService } from '../services/operator-arbiter.service';
import { answerOrQueued } from './approval-response';

/**
 * The arbiter page (assay-evm D-19): the records disputed on chain, and the
 * unsigned transactions the ARBITER's wallet signs to rule on them or to block
 * an address. The backend holds no arbiter key; every route here builds and
 * the two that build a ruling or a block write an override entry (`S-13`,
 * `A-11`). The case moves when the chain watcher sees the arbiter's
 * transaction land, never because an intent was built.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator/arbiter')
export class OperatorArbiterController {
  constructor(
    private readonly disputes: SlashDisputeIntentService,
    private readonly arbiter: OperatorArbiterService,
  ) {}

  @Get('terms')
  @ApiOperation({ summary: 'The Config’s arbiter, admin, pause flag and slash delay, read live' })
  async terms(@Query() query: ArbiterTermsQueryDto) {
    return this.disputes.chainTerms(query.chainId);
  }

  @Get('disputes')
  @ApiOperation({ summary: 'Every slash record disputed on chain, oldest dispute first' })
  async disputed() {
    return { items: await this.disputes.disputedOnChain() };
  }

  /** `S-13` — the arbiter's `upholdSlashBatch` or `cancelSlashBatch`, 1 to 64 ids. */
  @Post('ruling-intent')
  @Override('S-13')
  @RequireRoles(OperatorRole.ADJL, OperatorRole.TRE)
  @HttpCode(200)
  @ApiOperation({ summary: "Build the arbiter's unsigned uphold or cancel of slash records" })
  @ApiResponse({ status: 200, type: SlashContractCallDto })
  @ApiResponse({ status: 409, description: 'No dispute upgrade, or no arbiter appointed' })
  @ApiResponse({ status: 422, description: 'One or more ids would revert the batch' })
  async ruling(
    @CurrentOperator() operator: OperatorSession,
    @Body() body: ArbiterRulingBodyDto,
  ): Promise<SlashContractCallDto> {
    return toDto(
      await this.disputes.arbiterRuling(
        {
          operator,
          reasonCode: body.reasonCode,
          note: body.note,
          ticketRef: body.ticketRef ?? null,
          requestId: RequestContext.getServerRequestId(),
        },
        body.chainId,
        body.ruling,
        body.requestIds,
      ),
    );
  }

  /**
   * `A-11` — the arbiter's `setBlocked(account, true)`. Block only, and
   * two-person: queued (202) until an `ADJL` approves it, and the approval's
   * result is the unsigned call.
   */
  @Post('block-intent')
  @Override('A-11')
  @RequireRoles(OperatorRole.ADJL, OperatorRole.SRE, OperatorRole.TRE)
  @HttpCode(200)
  @ApiOperation({ summary: "Build the arbiter's unsigned on-chain block of an address" })
  @ApiResponse({ status: 200, type: SlashContractCallDto })
  @ApiResponse({
    status: 202,
    description: 'Queued for a second operator',
    type: ApprovalQueuedDto,
  })
  @ApiResponse({ status: 409, description: 'Already blocked, no upgrade, or no arbiter' })
  async block(
    @CurrentOperator() operator: OperatorSession,
    @Body() body: ArbiterBlockBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SlashContractCallDto | ApprovalQueuedDto> {
    const result = await this.arbiter.block(
      {
        operator,
        reasonCode: body.reasonCode,
        note: body.note,
        ticketRef: body.ticketRef ?? null,
        requestId: RequestContext.getServerRequestId(),
      },
      body.chainId,
      body.account,
    );
    return answerOrQueued(response, isApprovalQueued(result) ? result : toDto(result));
  }
}

function toDto(call: SlashContractCall): SlashContractCallDto {
  return { ...call, requestIds: [...call.requestIds] };
}
