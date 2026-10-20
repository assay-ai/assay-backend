import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { RequestContext } from '@shared/observability';
import { CurrentOperator, OperatorAuthGuard, OperatorRolesGuard, RequireRoles } from '@shared/auth';

import { OperatorRole } from '../domain/override-register';
import {
  CancelIntentDto,
  CompensatedBodyDto,
  CompensationIntentDto,
  ManualCaseActionBodyDto,
  OperatorDto,
} from '../dto/operator-console.dto';
import { ListOperatorCasesQueryDto, OperatorCaseListRowDto } from '../dto/operator-case-list.dto';
import { Override, OverrideExempt } from '../decorators/override.decorator';
import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import { answerOrQueued } from './approval-response';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { OperatorSession } from '../ports/operator-session.port';
import { OperatorCaseListService } from '../services/operator-case-list.service';
import { OperatorCaseService } from '../services/operator-case.service';
import { OperatorService } from '../services/operator.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/**
 * The operator's case surface: the Penalties list, the case brief, and the
 * on-chain follow-ups (cancel, compensation, the stuck-case actions). An EVM
 * case is decided by the arbiter on chain; nothing here decides one.
 *
 * ## Three guards, and each answers a different question
 *
 * - `OperatorAuthGuard` — *who is this?* It authenticates and attaches the
 *   session. It authorises nothing, exactly like `SessionAuthGuard`.
 * - `OperatorRolesGuard` — *may they do this kind of thing?* Fails closed: a
 *   mutating handler with no `@RequireRoles` is refused rather than being
 *   silently open.
 * - `OperatorOverrideGuard` — *is this recorded?* Refuses any mutating handler
 *   that does not name a row of the override register.
 *
 * The third is the one the override register depends on. `OverrideLogService` makes the
 * register entry atomic with the mutation; this guard makes declaring one
 * unavoidable. Neither is the property on its own — the service can be bypassed
 * by a handler that simply does not call it, and the guard cannot make a
 * handler that does call it write a truthful entry.
 *
 * ## Every route here reads across organizations
 *
 * By construction: an adjudicator has no tenant of their own, and a queue that
 * had to enumerate tenants would miss the next provider onboarded. That is why
 * the operator surface is a separate controller behind a separate guard rather
 * than a `?organizationId=` parameter on the provider one — a scope you can ask
 * for is a scope somebody will ask for by accident.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator')
export class OperatorCasesController {
  constructor(
    private readonly cases: OperatorCaseService,
    private readonly operators: OperatorService,
    private readonly caseList: OperatorCaseListService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Who is signed in, and what they may do' })
  @ApiResponse({ status: 200, type: OperatorDto })
  async me(@CurrentOperator() operator: OperatorSession): Promise<OperatorDto> {
    // Re-read rather than project the session, so a change applied since the
    // sign-in shows here immediately. The session is what got the
    // request in; the row is what says what may be done with it.
    const entity = await this.operators.requireActive(operator.operatorId);
    return this.operators.toDto(entity);
  }

  /**
   * Every penalty, by where it stands now — the console's Penalties list.
   *
   * Read-only and open to every operator role: Support and on-call need to
   * find a penalty as much as an adjudicator does. One fixed order (next
   * deadline, then amount, then newest): the list must not be re-sortable into
   * one that lets the urgent ones lapse.
   * A static segment, so it never reaches `cases/:proposalId`'s UUID pipe.
   */
  @Get('cases')
  @TenantCache({ ttl: 15, vary: 'operator', epochs: ['operator'], singleFlight: true })
  @ApiOperation({
    summary: 'Every penalty, next deadline first, filterable by status and provider',
  })
  @ApiCursorPage(OperatorCaseListRowDto)
  async listCases(
    @Query() query: ListOperatorCasesQueryDto,
  ): Promise<CursorPageDto<OperatorCaseListRowDto>> {
    return this.caseList.list(query);
  }

  @Get('cases/:proposalId')
  @ApiOperation({ summary: 'The full case brief for one proposal' })
  async getCase(@Param('proposalId', ParseUUIDPipe) proposalId: string) {
    return this.cases.brief(proposalId);
  }

  /**
   * `S-5`, step one — build the treasury's compensating `deposit_stake`.
   *
   * Reads and builds; changes nothing. `reverse_slash` is gone from the
   * program, so putting a wrongly-taken penalty back is a plain deposit into
   * the provider's stake, signed by the treasury's multisig and never by this
   * platform. Not an override in itself — {@link compensated} is, because that
   * is the call that writes.
   */
  @Post('cases/:proposalId/compensation-intent')
  @OverrideExempt(
    'Builds an unsigned transaction and writes nothing; `compensated` is the override',
  )
  @RequireRoles(OperatorRole.ADJL, OperatorRole.TRE)
  @ApiOperation({ summary: "Build the treasury's unsigned deposit_stake for an executed slash" })
  @ApiResponse({ status: 201, type: CompensationIntentDto })
  @ApiResponse({ status: 409, description: 'Never executed, or already compensated' })
  @ApiResponse({ status: 503, description: 'No settlement program to build against' })
  async compensationIntent(
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
  ): Promise<CompensationIntentDto> {
    return this.cases.compensationIntent(proposalId);
  }

  /**
   * `S-5`, step two — record a compensation the treasury has paid.
   *
   * Two-person, and irreversible. The signature is verified against the chain
   * before anything is queued or written: it must be a confirmed deposit into
   * this provider's own stake for at least what was taken. Queued with 202
   * `{approvalId}`; the approval verifies it again.
   */
  @Post('cases/:proposalId/compensated')
  @Override('S-5')
  @RequireRoles(OperatorRole.ADJL, OperatorRole.TRE)
  @ApiOperation({ summary: 'Record the treasury deposit that compensated an executed slash' })
  @ApiResponse({
    status: 202,
    type: ApprovalQueuedDto,
    description: 'Queued for a second operator',
  })
  @ApiResponse({ status: 409, description: 'Never executed, already compensated, or unconfirmed' })
  async compensated(
    @CurrentOperator() operator: OperatorSession,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: CompensatedBodyDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return answerOrQueued(
      response,
      await this.cases.compensated(operator, proposalId, body, requestIdOf()),
    );
  }

  /**
   * Build the settlement admin's unsigned `cancel_slash`.
   *
   * Reads and builds; changes no case status, and deliberately is not an
   * override (reading the chain only brings part mirrors up to date).
   * The on-chain record moved to `CANCEL_REQUESTED` when the case was
   * overturned or suspended; it moves to `CANCELLED` when the lifecycle sweep
   * sees the record leave `Pending`, not because somebody was handed a
   * transaction. When nothing stands on chain, it answers 409 and still
   * changes no case status.
   */
  @Post('cases/:proposalId/cancel-intent')
  @OverrideExempt(
    'Builds an unsigned transaction and changes no case status (the chain read only syncs part ' +
      'mirrors); the decision that requested the cancel was the override',
  )
  @RequireRoles(OperatorRole.ADJL, OperatorRole.TRE)
  @ApiOperation({ summary: "Build the settlement admin's unsigned cancel_slash" })
  @ApiResponse({ status: 201, type: CancelIntentDto })
  @ApiResponse({
    status: 409,
    description:
      'SLASH_NOTHING_STANDING: nothing of the case is Pending or Disputed on chain, so there is ' +
      'nothing to sign; no case status is changed. `error.context`: `proposalId`; `chainStatus` ' +
      '(EXECUTED — the stake was taken while the cancel waited; CANCELLED; NOT_FOUND; ' +
      'PROPOSING — a part may still land)',
  })
  @ApiResponse({
    status: 503,
    description:
      'SLASH_CHAIN_UNAVAILABLE: no transaction could be built (no settlement program, or the ' +
      'record could not be read). `error.context.reason` says why',
  })
  async cancelIntent(
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
  ): Promise<CancelIntentDto> {
    return this.cases.cancelIntent(proposalId);
  }

  /**
   * B18 `S-15` — close a requested cancel that nothing on chain is left to act
   * on: a case closed with no penalty whose own record reads `Cancelled` on a
   * fresh chain read. One person's act: it moves no money and sends nothing.
   * Only for the case shape the admin-cancel sweep cannot settle.
   */
  @Post('cases/:proposalId/close-nothing-standing')
  @Override('S-15')
  @RequireRoles(OperatorRole.ADJL, OperatorRole.TRE)
  @ApiOperation({ summary: 'Close a requested cancel when nothing stands on chain' })
  @ApiResponse({
    status: 409,
    description:
      'SLASH_MANUAL_ACTION_REFUSED: the guard does not hold on the fresh read, or the case ' +
      'changed. `error.context`: `proposalId`, `action`, `reason`, `chainRecord`',
  })
  @ApiResponse({
    status: 503,
    description: 'SLASH_CHAIN_UNAVAILABLE: the record could not be read',
  })
  async closeNothingStanding(
    @CurrentOperator() operator: OperatorSession,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: ManualCaseActionBodyDto,
  ) {
    return this.cases.closeNothingStanding(operator, proposalId, body, requestIdOf());
  }

  /**
   * B18 `S-16` — record an execution the chain made while the cancel waited,
   * through the existing recording path. Two-person: queued with 202
   * `{approvalId}`; the approval reads the chain again and runs it.
   */
  @Post('cases/:proposalId/record-execution')
  @Override('S-16')
  @RequireRoles(OperatorRole.ADJL, OperatorRole.TRE)
  @ApiOperation({ summary: 'Record an on-chain execution that happened while the cancel waited' })
  @ApiResponse({
    status: 202,
    type: ApprovalQueuedDto,
    description: 'Queued for a second operator',
  })
  @ApiResponse({ status: 409, description: 'SLASH_MANUAL_ACTION_REFUSED' })
  @ApiResponse({ status: 503, description: 'SLASH_CHAIN_UNAVAILABLE' })
  async recordExecution(
    @CurrentOperator() operator: OperatorSession,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: ManualCaseActionBodyDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return answerOrQueued(
      response,
      await this.cases.recordExecution(operator, proposalId, body, requestIdOf()),
    );
  }

  /**
   * B18 `S-17` — propose an upheld penalty again once its cancelled record is
   * gone. Two-person: queued with 202 `{approvalId}`. Approved, the case moves
   * to a fresh epoch and the scheduler's propose pass puts it on chain.
   */
  @Post('cases/:proposalId/repropose')
  @Override('S-17')
  @RequireRoles(OperatorRole.ADJL, OperatorRole.TRE)
  @ApiOperation({ summary: 'Propose an upheld penalty again after its record was cancelled' })
  @ApiResponse({
    status: 202,
    type: ApprovalQueuedDto,
    description: 'Queued for a second operator',
  })
  @ApiResponse({ status: 409, description: 'SLASH_MANUAL_ACTION_REFUSED' })
  @ApiResponse({ status: 503, description: 'SLASH_CHAIN_UNAVAILABLE' })
  async repropose(
    @CurrentOperator() operator: OperatorSession,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: ManualCaseActionBodyDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return answerOrQueued(
      response,
      await this.cases.repropose(operator, proposalId, body, requestIdOf()),
    );
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
