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
  AdjudicationQueueRowDto,
  CancelIntentDto,
  CompensatedBodyDto,
  CompensationIntentDto,
  DecideCaseBodyDto,
  ExtendDeadlineBodyDto,
  FleetSweepDto,
  ListQueueQueryDto,
  OpenFleetSweepBodyDto,
  OperatorDto,
  SecondSignatureBodyDto,
  SuspendProposalBodyDto,
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

/**
 * The adjudication surface: the queue, the case decision and the second signature.
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
   * The queue.
   *
   * Ordered by time-to-deadline, then penalty size — deliberately, and not a
   * default: FIFO against a hard deadline guarantees the oldest case expires
   * first, and an expired case is overturned against us.
   */
  @Get('queue')
  @ApiOperation({ summary: 'Open cases, ordered by time-to-deadline then penalty size' })
  @ApiCursorPage(AdjudicationQueueRowDto)
  async queue(
    @CurrentOperator() operator: OperatorSession,
    @Query() query: ListQueueQueryDto,
  ): Promise<CursorPageDto<AdjudicationQueueRowDto>> {
    return this.cases.listQueue(operator, query);
  }

  /**
   * Every penalty, by where it stands now — the console's Penalties list.
   *
   * Read-only and open to every operator role, like the queue: Support and
   * on-call need to find a penalty as much as an adjudicator does. One fixed
   * order (next deadline, then amount, then newest), for the queue's reason:
   * the list must not be re-sortable into one that lets the urgent ones lapse.
   * A static segment, so it never reaches `cases/:proposalId`'s UUID pipe.
   */
  @Get('cases')
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
   * Take ownership.
   *
   * The one mutating route with no register row, exempt by a named decorator
   * rather than by omission — so it appears in the coverage test as a decision
   * somebody made, not as one nobody made.
   */
  @Post('cases/:proposalId/claim')
  @OverrideExempt('Assignment moves no money and changes nobody’s state but the queue’s')
  @RequireRoles(OperatorRole.ADJ, OperatorRole.ADJL)
  @ApiOperation({ summary: 'Assign this case to yourself' })
  async claim(
    @CurrentOperator() operator: OperatorSession,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
  ) {
    return this.cases.claim(operator, proposalId);
  }

  /**
   * `S-3` — decide.
   *
   * The reason code and the 120-character explanation are validated on the DTO
   * and again by `chk_override_log_entries_decision_reason_length`. There is no
   * path that records a decision without both, and that includes a lead and an
   * admin: the exclusion is explicit.
   */
  @Post('cases/:proposalId/decide')
  @Override('S-3')
  @RequireRoles(OperatorRole.ADJ, OperatorRole.ADJL)
  @ApiOperation({ summary: 'Decide a case — one of six outcomes, with a reason' })
  @ApiResponse({ status: 422, description: 'Reason code invalid for the chosen outcome' })
  async decide(
    @CurrentOperator() operator: OperatorSession,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: DecideCaseBodyDto,
  ) {
    return this.cases.decide(operator, proposalId, body, requestIdOf());
  }

  /** `S-12` — countersign, or object. An objection returns the case undecided. */
  @Post('cases/:proposalId/second')
  @Override('S-12')
  @RequireRoles(OperatorRole.ADJ, OperatorRole.ADJL)
  @ApiOperation({ summary: 'Countersign or object to another adjudicator’s decision' })
  async second(
    @CurrentOperator() operator: OperatorSession,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: SecondSignatureBodyDto,
  ) {
    return this.cases.second(operator, proposalId, body, requestIdOf());
  }

  /**
   * `S-1` — suspend a proposal.
   *
   * Closes the case and asks for the cancel of any record standing on chain
   * (`chain_status` → `CANCEL_REQUESTED`). The cancel itself is the settlement
   * admin's to sign — see {@link cancelIntent}.
   *
   * Single-person from `PROPOSED`, `DISPUTED` and `UNDER_REVIEW`. From
   * `AWAITING_SECOND` and `UPHELD` it is two-person: the call is queued and
   * answers 202 `{approvalId}`; a second operator holding `ADJ` or `ADJL`, with
   * an authority limit that covers the penalty, approves it in
   * `POST /operator/approvals/:id/approve`.
   */
  @Post('cases/:proposalId/suspend')
  @Override('S-1')
  @RequireRoles(OperatorRole.ADJ, OperatorRole.ADJL, OperatorRole.SRE)
  @ApiOperation({ summary: 'Suspend a pending proposal' })
  @ApiResponse({
    status: 202,
    type: ApprovalQueuedDto,
    description: 'Queued for a second operator',
  })
  async suspend(
    @CurrentOperator() operator: OperatorSession,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: SuspendProposalBodyDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return answerOrQueued(
      response,
      await this.cases.suspend(operator, proposalId, body, requestIdOf()),
    );
  }

  /**
   * `S-8` — give the provider more time.
   *
   * The register requires that this *also* extends body retention for that
   * window, and it does not yet: `evidence_bodies` are scrubbed at 72 hours on
   * their own schedule, with no per-window hold. An extended deadline that
   * outlives the evidence leaves the adjudicator deciding on hashes, which is
   * exactly the evidence-freshness risk to avoid. Left as a known gap rather than
   * silently half-implemented.
   */
  @Post('cases/:proposalId/extend-deadline')
  @Override('S-8')
  @RequireRoles(OperatorRole.ADJL)
  @ApiOperation({ summary: 'Extend the provider’s deadline to object' })
  async extendDeadline(
    @CurrentOperator() operator: OperatorSession,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: ExtendDeadlineBodyDto,
  ) {
    return this.cases.extendDeadline(operator, proposalId, body, requestIdOf());
  }

  /**
   * `S-11` — carry this conclusion to every binding the same defect touched.
   *
   * Two-person: the call is queued and answers 202 `{approvalId}`, and a
   * second operator holding `ADJ` or `ADJL` (the register row's
   * `approverRoles`) approves it with their own session.
   * `chk_override_log_entries_no_self_approval` refuses self-approval at the
   * database in any case.
   */
  @Post('cases/:proposalId/sweep')
  @Override('S-11')
  @RequireRoles(OperatorRole.ADJL)
  @ApiOperation({ summary: 'Open a fleet sweep from this decided case' })
  @ApiResponse({
    status: 202,
    type: ApprovalQueuedDto,
    description: 'Queued for a second operator',
  })
  @ApiResponse({ status: 422, description: 'This outcome does not generalise' })
  async sweep(
    @CurrentOperator() operator: OperatorSession,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: OpenFleetSweepBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<FleetSweepDto | ApprovalQueuedDto> {
    return answerOrQueued(
      response,
      await this.cases.openSweep(operator, proposalId, body, requestIdOf()),
    );
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
   * Reads and builds; changes nothing, and deliberately is not an override.
   * The on-chain record moved to `CANCEL_REQUESTED` when the case was
   * overturned or suspended; it moves to `CANCELLED` when the lifecycle sweep
   * sees the record leave `Pending`, not because somebody was handed a
   * transaction. When nothing stands on chain, it answers 409 and still
   * changes nothing.
   */
  @Post('cases/:proposalId/cancel-intent')
  @OverrideExempt(
    'Builds an unsigned transaction and writes nothing; the decision that requested the cancel ' +
      'was the override',
  )
  @RequireRoles(OperatorRole.ADJL, OperatorRole.TRE)
  @ApiOperation({ summary: "Build the settlement admin's unsigned cancel_slash" })
  @ApiResponse({ status: 201, type: CancelIntentDto })
  @ApiResponse({
    status: 409,
    description:
      'SLASH_NOTHING_STANDING: nothing of the case is Pending or Disputed on chain, so there is ' +
      'nothing to sign; nothing is changed. `error.context`: `proposalId`; `chainStatus` ' +
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
