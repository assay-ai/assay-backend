import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
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
  ArbiterSupersededCancelBodyDto,
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

  /**
   * Review R2-6: records of an earlier epoch of their case that landed late
   * and still stand. Each would charge the same calls twice if executed; the
   * arbiter cancels it (`superseded/cancel-intent`).
   */
  @Get('superseded')
  @ApiOperation({ summary: 'Superseded earlier-epoch slash records still standing on chain' })
  async superseded() {
    return { items: await this.disputes.supersededOnChain() };
  }

  /**
   * Review R2-6: `S-13`, the arbiter's `cancelSlashBatch` of one superseded
   * record. 409 when the id is not a superseded record standing on the chain.
   */
  @Post('superseded/cancel-intent')
  @Override('S-13')
  @RequireRoles(OperatorRole.ADJL, OperatorRole.TRE)
  @HttpCode(200)
  @ApiOperation({ summary: "Build the arbiter's unsigned cancel of a superseded slash record" })
  @ApiResponse({ status: 200, type: SlashContractCallDto })
  @ApiResponse({ status: 409, description: 'Not a superseded record, or no arbiter appointed' })
  @ApiResponse({ status: 422, description: 'The chain would refuse the cancel' })
  async supersededCancel(
    @CurrentOperator() operator: OperatorSession,
    @Body() body: ArbiterSupersededCancelBodyDto,
  ): Promise<SlashContractCallDto> {
    return toDto(
      await this.disputes.supersededCancel(
        {
          operator,
          reasonCode: body.reasonCode,
          note: body.note,
          ticketRef: body.ticketRef ?? null,
          requestId: RequestContext.getServerRequestId(),
        },
        body.chainId,
        body.requestId,
      ),
    );
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

  /**
   * Review N-5: the unsigned `setBlocked` of an APPROVED `A-11`, rebuilt from
   * the approved payload so the arbiter's wallet can sign it after the
   * approver's tab is gone. Builds only and writes nothing; 409 once the
   * address is blocked on chain.
   */
  @Get('blocks/:approvalId/call')
  @RequireRoles(OperatorRole.ADJL, OperatorRole.SRE, OperatorRole.TRE)
  @ApiOperation({ summary: 'The unsigned on-chain block of an approved A-11, for the arbiter' })
  @ApiResponse({ status: 200, type: SlashContractCallDto })
  @ApiResponse({ status: 409, description: 'Not an approved block, or already blocked' })
  async approvedBlock(
    @Param('approvalId', new ParseUUIDPipe()) approvalId: string,
  ): Promise<SlashContractCallDto> {
    return toDto(await this.arbiter.approvedBlockCall(approvalId));
  }
}

function toDto(call: SlashContractCall): SlashContractCallDto {
  return { ...call, requestIds: [...call.requestIds] };
}
