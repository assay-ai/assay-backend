import {
  AccountId,
  AssetId,
  ChainNamespace,
  chainIdOf,
  namespaceOf,
  parseAccountId,
} from '@modules/chains/ports/caip.types';
import { isSolanaTransaction } from '@modules/chains/ports/unsigned-chain-transaction';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { QueryRunner } from 'typeorm';

import { DisputeEntity } from '@database/postgres/entities/dispute.entity';
import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { FleetSweepEntity } from '@database/postgres/entities/fleet-sweep.entity';
import { FleetSweepRepository } from '@database/postgres/repositories/fleet-sweep.repository';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import {
  CHAIN_PROPOSABLE_STATUSES,
  CLOSED_WITHOUT_PENALTY_STATUSES,
  QueuedProposalRow,
  SlashProposalRepository,
} from '@database/postgres/repositories/slash-proposal.repository';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import { ProviderErrors } from '@modules/provider/errors/provider.errors';
import {
  STAKE_INTENT_BUILDER,
  StakeIntentBuilderPort,
  StakeIntentKind,
} from '@modules/provider/ports/stake-intent-builder.port';
import { MoneyUtil } from '@shared/utils/money.util';

import { SlashBeneficiaryService } from './slash-beneficiary.service';
import { SlashCompensationService } from './slash-compensation.service';
import { SlashPartsService } from './slash-parts.service';
import { DISPUTE_TIMEOUT_MS, SLASH_CONFIG, SlashConfig } from '../constants/slash.constants';
import { SLASH_PROPOSAL_SUBJECT_TYPE } from '../constants/slash-subject.constants';
import {
  ARBITRATION_STATE_MAP,
  ArbitrationOutcome,
  OUTCOME_CONSEQUENCE,
  ResolutionKind,
} from '../domain/arbitration';
import {
  ChainFailureKind,
  ChainProposalStatus,
  chainErrorName,
  classifyChainFailure,
} from '../domain/chain-slash-outcome';
import { canTransition, SlashProposalStatus } from '../domain/slash-proposal-state';
import { SlashErrors } from '../errors/slash.errors';
import {
  SLASH_EXECUTOR,
  SlashCancelIntent,
  SlashCompensationIntent,
  SlashCancelResult,
  SlashExecutionResult,
  SlashExecutorPort,
  SlashRecordSnapshot,
  SlashRecordStatus,
} from '../ports/slash-executor.port';
import { deriveChainRequestId, SlashProposalService } from './slash-proposal.service';

/**
 * How long a `PROPOSING` / `EXECUTING` claim may stand before it is treated as
 * orphaned.
 *
 * Long enough that a slow confirmation is not reaped mid-flight
 * (`CONFIRM_TIMEOUT_MS` on the executor is 60 s), short enough that a crashed
 * pod does not park a case for a shift.
 *
 * Exported because the reconcile sweep measures the same window against the
 * same column, and two copies of one number is how they come to disagree.
 */
export const CHAIN_CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * The row's mirror of what the chain says a record is.
 *
 * A total map rather than a `switch`, so a fourth `SlashStatus` is a compile
 * error here rather than a silent fall-through into `PENDING` — which would
 * schedule an execution against a record that can never take one.
 */
const CHAIN_STATUS_FOR_RECORD: Readonly<Record<SlashRecordStatus, ChainProposalStatus>> =
  Object.freeze({
    PENDING: ChainProposalStatus.PENDING,
    DISPUTED: ChainProposalStatus.DISPUTED,
    EXECUTED: ChainProposalStatus.EXECUTED,
    CANCELLED: ChainProposalStatus.CANCELLED,
  });

/**
 * The statuses a case may be closed from when the chain voids its judgement.
 *
 * Every one of them carries `outcome IS NULL`, `'UPHELD'` or
 * `'UPHELD_RECALCULATED'` and nothing else — `statusForOutcome` sends all four
 * overturns to `OVERTURNED`, and `decide()` holds the outcome back entirely
 * while a case is `AWAITING_SECOND`. That is not a coincidence, it is the
 * precondition `chk_slash_proposals_outcome_needs_adjudicator` was relaxed
 * against: it admits `AUTO_CHAIN_VOIDED` beside those two outcomes and refuses
 * it beside an `OVERTURNED_*`. **Adding a status to this list without checking
 * that property writes rows Postgres rejects.**
 */
const CHAIN_VOIDABLE_STATUSES: readonly SlashProposalStatus[] = [
  SlashProposalStatus.PROPOSED,
  SlashProposalStatus.DISPUTED,
  SlashProposalStatus.UNDER_REVIEW,
  SlashProposalStatus.AWAITING_SECOND,
  SlashProposalStatus.UPHELD,
  SlashProposalStatus.EXECUTING,
];

/**
 * `SLASH_EXECUTION_GRACE_SECONDS` — the program's constant, mirrored.
 *
 * After `SlashRecord.executable_at + 7d`, `expire_slash` is permissionless: any
 * account at all may reap a still-`Pending` record, the reservation is released
 * and the judgement can never be executed. The penalty is discharged and the
 * harmed agent is never compensated.
 *
 * It is also the instant {@link SlashExecutionService.sweepAdminCancels} starts
 * calling that door itself, on a record whose admin cancel never arrived —
 * which is the whole answer to "what if nobody signs it".
 *
 * Exported so the sweep's spec measures the same window the sweep does.
 */
export const SLASH_EXECUTION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** After this much of that grace has burned on refusals, say so out loud. */
const GRACE_WARNING_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * The Solana program's floor on `Config.slash_delay_seconds`, 72 h — used for
 * a namespace whose executor cannot report its live delay. On EVM the delay
 * is READ (`EvmSlashExecutor.slashDelaySeconds`); since the dispute upgrade
 * the admin may set it as low as ten minutes, so no EVM path may assume 72 h.
 */
const SOLANA_MIN_SLASH_DELAY_MS = 72 * 60 * 60 * 1000;

/**
 * `MIN_SLASH_DELAY_SECONDS` on EVM since the dispute upgrade (ten minutes) —
 * the shortest delay an upgraded Config can hold, used only when the live
 * value cannot be read.
 */
const EVM_MIN_SLASH_DELAY_MS = 10 * 60 * 1000;

/**
 * `VOID` names that must **not** close the case on the *execute* path.
 *
 * `SlashNotPending` is `VOID` for the classifier's purposes — the record has
 * left `Pending` and will never take another `execute_slash` — and that is the
 * right answer for `cancel_slash` and `expire_slash`. Here it is not enough to
 * close a case, because one of the three ways a record leaves `Pending` is by
 * being **Executed**: by this platform's own attempt whose confirmation timed
 * out, or by a stranger, since `execute_slash` consults nobody but a fee payer.
 * Cancelling on it would tell the provider a penalty was dropped that was in
 * fact taken.
 *
 * So the row stays `EXECUTING` and {@link SlashExecutionService.reconcileExecuting}
 * reads the record. Reading is the only thing that can tell the two apart.
 */
const EXECUTE_MUST_READ_THE_RECORD: ReadonlySet<string> = new Set(['SlashNotPending']);

/**
 * `chain_last_error` marker for the one outcome this schema cannot represent.
 *
 * A stranger executed the record while an adjudicator was lowering the penalty,
 * so the chain took the ORIGINAL frozen figure and `applied` is now larger than
 * the `penalty_amount` the row carries. `chk_slash_proposals_applied_within_penalty`
 * (`applied_amount <= penalty_amount`) refuses the write, and every honest way
 * out of that needs a decision no code should take on its own: falsifying
 * `applied` hides money that moved, and raising `penalty_amount` back overwrites
 * an adjudicator with a chain event.
 *
 * So the row records the marker and a human is told. It exists because without
 * it the case would sit in `findChainExecutable` forever, spending two RPCs a
 * minute rediscovering the same thing — {@link SlashExecutionService.executeDue}
 * reads it and skips.
 *
 * Reachable only after a downward `UPHELD_RECALCULATED`. Every overturn path
 * leaves `penalty_amount` alone, so `applied <= reserved <= penalty_amount`
 * holds and the execution records normally.
 */
const EXECUTED_BEYOND_DECISION = 'ExecutedBeyondDecision';

/**
 * Everything that touches the chain, and the fleet sweep that follows an
 * overturn.
 *
 * ## Why execution is a scheduled step and not the end of `decide`
 *
 * The case screen promises the provider, in the largest type on the screen, that
 * nothing executes before the deadline *even if they do nothing*. A
 * decide-then-execute path would make that promise depend on how quickly an
 * adjudicator worked — a case decided in an hour would execute in an hour. The
 * timelock is not a queue delay; it is the interval in which the appeal is
 * still meaningful, and the only way it stays a promise is if the thing that
 * executes reads the clock rather than the decision.
 *
 * `chk_slash_proposals_execution_respects_timelock` refuses the row too, so a
 * future caller that forgets cannot break it either.
 */
@Injectable()
export class SlashExecutionService {
  private readonly logger = new Logger(SlashExecutionService.name);

  constructor(
    private readonly proposals: SlashProposalRepository,
    private readonly enrolments: ProviderChainEnrolmentRepository,
    private readonly sweeps: FleetSweepRepository,
    private readonly lifecycle: SlashProposalService,
    private readonly overrides: OverrideLogService,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @Inject(SLASH_CONFIG) private readonly config: SlashConfig,
    // `@Optional()` because a process may compose this service without
    // `ChainsModule` — NOT because the binding is scheduler-only. It is not:
    // `ChainsModule` provides `SLASH_EXECUTOR` unconditionally, so any process
    // importing that module resolves a real executor here. (This comment used to
    // claim it was "null on every process that is not the scheduler — the same
    // shape `EXPOSURE_AUTHORITY_SIGNER` already uses"; that binding really is
    // `SERVICE_TYPE`-gated and this one never was. See
    // `slash-scheduler.module.ts` for where the false symmetry led.)
    //
    // What stops an API pod actually submitting a slash is that
    // `SolanaSlashExecutor` reaches `VerifierSigningService` through `ModuleRef`
    // at call time, and only the worker bootstrap imports
    // `VerifierSigningModule` — so the throw happens at the first call, in
    // whichever process had no business signing, rather than at injection.
    @Optional() @Inject(SLASH_EXECUTOR) private readonly executor: SlashExecutorPort | null,
    // Optional for the same structural reason: it reads the chain through
    // `SLASH_EXECUTOR` and `VaultPort`, so a composition lacking those has
    // nothing for it to read.
    @Optional() private readonly beneficiaries: SlashBeneficiaryService | null = null,
    // Optional for the same reason: it is only reachable on the path that
    // actually executes.
    @Optional() private readonly compensation: SlashCompensationService | null = null,
    // The treasury's compensating `deposit_stake` — built here, signed by the
    // treasury's multisig, and read back off the cluster by
    // `confirmedDeposit`. Optional for the same structural reason as the
    // executor: a composition without `ChainsModule` has nothing to build
    // against.
    @Optional()
    @Inject(STAKE_INTENT_BUILDER)
    private readonly stakeIntents: StakeIntentBuilderPort | null = null,
    // Window-level EVM cases — one attestation per harmed agent. Optional
    // for the same structural reason as the executor; absent, every case takes
    // the single-judgement path it always has.
    @Optional() private readonly parts: SlashPartsService | null = null,
  ) {}

  /**
   * Put every live judgement on chain, so the 72-hour on-chain delay runs
   * *beside* the off-chain dispute window rather than after it.
   *
   * This is the half that buys the response time. `propose_slash`
   * cannot move a lamport — there is no token account in its accounts struct at
   * all — so running it early costs the provider nothing but a reservation, and
   * that reservation is what stops them outrunning a judgement by withdrawing
   * during the wait.
   *
   * It runs in the scheduler and nowhere else, and it is a *sweep* rather than a
   * call inside `markDelivered` for a reason that is about process boundaries:
   * a proposal is opened by the API on the `DATA_FAIL` door, and no API pod may
   * hold a key that can reserve a provider's stake. The row is the queue.
   *
   * The three counters are outcomes of the *sweep*, not verdicts on the case:
   *
   * - `proposed` — the row now mirrors a `Pending` record and the clock runs.
   * - `refused` — the request id is spent and this sweep will never try it
   *   again: a permanent program refusal, or a record already on chain that is
   *   no longer `Pending`.
   * - `failed` — a transient failure. The claim is left standing and the stale
   *   sweep retries it in {@link CHAIN_CLAIM_STALE_MS}.
   */
  async proposeDue(now: Date = new Date()): Promise<{
    proposed: number;
    refused: number;
    failed: number;
  }> {
    if (!this.executor) {
      throw SlashErrors.notExecuted({ status: 'no slash executor is configured' });
    }

    // One value, used by the selection and by the claim, because the claim's
    // stale predicate has to admit exactly the rows the selection returns. Two
    // `new Date()` calls a few statements apart would differ by milliseconds
    // and could select a row the claim then refuses forever.
    const staleClaimBefore = new Date(now.getTime() - CHAIN_CLAIM_STALE_MS);

    const due = await this.proposals.findAwaitingChainProposal(
      now,
      staleClaimBefore,
      this.config.sweepBatchSize,
    );

    let proposed = 0;
    let refused = 0;
    let failed = 0;
    // The live delay per chain, read once per pass (see `slashDelayMs`).
    const delays = new Map<string, number>();

    for (const candidate of due) {
      const proposal = await this.proposals.findOneScoped(candidate.organizationId, candidate.id);
      if (!proposal) continue;
      const delayMs = await this.slashDelayMs(proposal, delays);

      // Proposing this case NOW would open the door before the promise closes.
      //
      // `execute_slash` is permissionless, and the record's `executable_at` is
      // frozen when it is written. `extendDeadline` may have pushed
      // `earliest_execution_at` out by up to 14 days
      // (`ExtendDeadlineBodyDto.additionalHours`) while the case was still
      // `NONE` — nothing on chain to compare against, so nothing refused it —
      // and this is the other end of that: the promise is honoured by writing
      // the record LATER, not by breaking it.
      //
      // A deferral and not a refusal. Nothing is claimed, nothing is counted,
      // no transaction is sent, and the row stays exactly what
      // `findAwaitingChainProposal` selects, so it proposes itself the first
      // tick on which the door can land after the promise. The whole penalty
      // arrives late; none of it is lost.
      //
      // Uncounted on purpose: the counters report what the chain did with a
      // judgement, and this one has deliberately not been shown to it yet.
      if (this.proposingNowWouldOutrunThePromise(proposal, now, delayMs)) {
        this.logger.debug(
          `slash proposal ${proposal.id} is not being proposed yet: its promise to the provider ` +
            `runs to ${proposal.earliestExecutionAt.toISOString()} and a record written now ` +
            `could become executable by anyone from ` +
            `${new Date(now.getTime() + delayMs).toISOString()}`,
        );
        continue;
      }

      // The claim, and the only thing that keeps two schedulers from both
      // signing an attestation for one case. Losing it is not an error: the
      // winner is already proposing, and counting it would make a healthy
      // two-pod deploy look like it was failing half its work.
      //
      // Both guards matter and neither is decoration.
      //
      // `PROPOSING` has to be in the accepted set — that is the first crash point,
      // a claim that landed with nobody left to send the transaction. But the
      // target being inside its own accepted set is exactly what makes a
      // plain `chain_status IN (…)` non-exclusive: the second worker re-reads
      // the committed row, finds `PROPOSING`, and is told it won as well.
      // `staleClaimBefore` restores the exclusion without giving up the
      // recovery — a fresh claim is somebody's live work, a stale one is
      // nobody's.
      //
      // `caseStatusIn` closes the gap between the sweep's SELECT and this
      // UPDATE. A batch is 100 rows and each one costs a confirmation, so the
      // last row can be reached minutes after it was chosen; an overturn or a
      // suspension landing in that window would otherwise reserve a terminal
      // case's stake. That is not untidy — `execute_slash` is permissionless,
      // so the stranded record is a stranger's to execute 72 hours later, and
      // `voidCase` could not clean it up because `OVERTURNED` is deliberately
      // outside `CHAIN_VOIDABLE_STATUSES`.
      const claimed = await this.proposals.claimChainStatus(
        proposal.organizationId,
        proposal.id,
        [ChainProposalStatus.NONE, ChainProposalStatus.PROPOSING],
        ChainProposalStatus.PROPOSING,
        now,
        { staleClaimBefore, caseStatusIn: CHAIN_PROPOSABLE_STATUSES },
      );
      if (claimed === 0) continue;

      try {
        const mirrored = await this.proposeOne(proposal);
        if (mirrored === ChainProposalStatus.PENDING) proposed += 1;
        else refused += 1;
      } catch (error) {
        // Classified from the error itself, never from a name parsed out of a
        // message: `CHAIN_SLASH_RECORD_NOT_FOUND` is terminal and carries no
        // Anchor error name at all.
        if (classifyChainFailure(error) === ChainFailureKind.VOID) {
          const name = chainErrorName(error);
          try {
            await this.voidCase(
              proposal,
              { status: ChainProposalStatus.REFUSED, lastError: name ?? 'unknown' },
              `the settlement program refused it permanently (${name ?? 'unnamed refusal'})`,
            );
            refused += 1;
          } catch (voidError) {
            // `voidCase` guards everything after its own transition, so the
            // only thing that reaches here is the transition itself failing —
            // which means nothing committed and the case is untouched and
            // still `PROPOSING`. Count it `failed` so the stale sweep retries,
            // and above all do not let it end the pass: one provider's
            // database blip must not hold every other provider's harmed agent
            // out of their compensation.
            failed += 1;
            this.logger.error(
              `slash proposal ${proposal.id} could not be voided after a permanent refusal`,
              voidError instanceof Error ? voidError.stack : String(voidError),
            );
          }
        } else {
          // Left `PROPOSING`. The stale sweep above picks it up in ten minutes,
          // and the chain's `init` makes that retry incapable of minting a
          // second penalty however many times it runs.
          failed += 1;
          await this.proposals.update(
            { organizationId: proposal.organizationId, id: proposal.id },
            // `'transport'` stands for every failure the program did not name —
            // an RPC error, an expired blockhash, a confirmation timeout, or a
            // local refusal before anything was ever sent.
            { chainLastError: chainErrorName(error) ?? localRefusalName(error) ?? 'transport' },
          );
          this.logger.error(
            `propose_slash failed for proposal ${proposal.id}`,
            error instanceof Error ? error.stack : String(error),
          );
          await this.flagPlanRefusal(proposal, error);
        }
      }
    }

    return { proposed, refused, failed };
  }

  /**
   * Put a refused plan (review H-2) on the case timeline, once: the sweep
   * retries every ten minutes and refuses again each time, and one entry is
   * enough to send an operator to look. Never throws; the refusal itself is
   * already on the row as `chain_last_error`.
   */
  private async flagPlanRefusal(proposal: SlashProposalEntity, error: unknown): Promise<void> {
    if ((error as { errorCode?: unknown })?.errorCode !== 'SLASH_PLAN_EVIDENCE_MISMATCH') return;
    if (proposal.chainLastError === 'SLASH_PLAN_EVIDENCE_MISMATCH') return;
    try {
      await this.lifecycle.appendEventDirect({
        organizationId: proposal.organizationId,
        proposalId: proposal.id,
        occurredAt: new Date(),
        kind: 'PLAN_REFUSED',
        actorType: 'system',
        actorId: null,
        summary:
          'Nothing was signed: the stored slash plan does not match the window evidence. ' +
          'An operator must check the parts before this case can go on chain.',
        detail: { reason: error instanceof Error ? error.message : String(error) },
      });
    } catch (appendError) {
      this.logger.error(
        `slash proposal ${proposal.id}: the plan refusal could not be put on the timeline`,
        appendError instanceof Error ? appendError.stack : String(appendError),
      );
    }
  }

  /**
   * Would a record written now become executable before the provider's deadline?
   *
   * Reads the row and a constant — no RPC, no `Config` fetch, no second query.
   * `delayMs` is the chain's live delay ({@link slashDelayMs}), so
   * `now + delayMs` is the earliest moment a record proposed on
   * this tick could be spent by a stranger. If the promise runs past that, the
   * only honest answers are "do not write the record yet" or "break the
   * promise", and this picks the first.
   *
   * One-sided by design. A `false` is a guarantee: the door provably lands at or
   * after the promise. A `true` may be pessimistic — the chain's configured
   * delay could be longer than its floor, in which case the case waits a little
   * longer than it strictly had to. Waiting too long costs delay; the other
   * error costs the provider their money inside a window they were told was
   * theirs.
   *
   * Adoption is the case this cannot cover: `propose()` may return a record
   * somebody else wrote at a `proposed_at` in the past, and its door is then
   * older than anything computable from `now`. {@link proposeOne} checks the
   * returned `executableAt` for exactly that.
   */
  private proposingNowWouldOutrunThePromise(
    proposal: SlashProposalEntity,
    now: Date,
    delayMs: number,
  ): boolean {
    return proposal.earliestExecutionAt.getTime() > now.getTime() + delayMs;
  }

  /**
   * How long after a proposal made now its record becomes executable, read
   * from the chain: on EVM `X402Config.slashDelaySeconds()` since the dispute
   * upgrade (settable, 10 minutes at the least) and the old contract's own
   * constant before it. Never assumed to be 72 hours on EVM. A namespace that
   * cannot say (Solana) uses its program's floor. A failed read falls back to
   * the SHORTEST delay the chain could have, which only ever defers a proposal.
   */
  private async slashDelayMs(
    proposal: SlashProposalEntity,
    cache: Map<string, number>,
  ): Promise<number> {
    const chainId = chainIdOf(proposal.assetId as AssetId);
    const known = cache.get(chainId);
    if (known !== undefined) return known;
    let delayMs = SOLANA_MIN_SLASH_DELAY_MS;
    try {
      const seconds = await this.executor?.slashDelaySeconds?.(chainId);
      if (typeof seconds === 'number') delayMs = seconds * 1000;
    } catch (error) {
      if (namespaceOf(proposal.assetId as AssetId) === ChainNamespace.EIP155) {
        delayMs = EVM_MIN_SLASH_DELAY_MS;
      }
      this.logger.warn(
        `the slash delay on ${chainId} could not be read; using ${delayMs / 1000}s for this pass ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
    cache.set(chainId, delayMs);
    return delayMs;
  }

  /**
   * One case, onto the chain, and the row updated from what the chain said.
   *
   * Returns the `chain_status` it wrote, so the caller can tally without
   * re-reading the row: `PENDING` is the live path and anything else means the
   * request id is spent.
   *
   * Also the re-proposal path after a cancel-and-bump, which is why it
   * takes the row rather than reading it: the caller has just moved
   * `chain_epoch` and `chain_request_id` and this must sign for the new ones.
   */
  private async proposeOne(proposal: SlashProposalEntity): Promise<ChainProposalStatus> {
    if (!this.executor) {
      throw SlashErrors.notExecuted({ status: 'no slash executor is configured' });
    }

    const result = this.parts?.appliesTo(proposal)
      ? // A window-level EVM case: one attestation per harmed agent, each
        // naming that agent as beneficiary, proposed in one batch. The case
        // row carries no single beneficiary; its parts do.
        await this.parts.propose(proposal, await this.stakeAuthorityOf(proposal))
      : await this.proposeSingle(proposal);

    const mirrored = CHAIN_STATUS_FOR_RECORD[result.status];

    // The case is closed BEFORE the chain mirror is written, and the order is
    // load-bearing rather than stylistic.
    //
    // What is on chain is immutable — neither `cancel_slash` nor `expire_slash`
    // closes the account, so this record reads `Cancelled` forever. So a crash
    // between the two leaves the row `PROPOSING` and claimed, the stale sweep
    // re-selects it, `propose()` adopts the *same* record, and the close runs
    // again (`transitionIfIn` makes the repeat a no-op). Nothing is lost.
    //
    // The reverse order has no such recovery: it would put the row outside
    // every sweep predicate — `chain_status` is no longer `NONE`/`PROPOSING`,
    // so the propose sweep skips it, and it was never `PENDING`, so the execute
    // sweep never sees it — with the case still open. A silent strand, found by
    // a human or not at all.
    if (mirrored === ChainProposalStatus.CANCELLED) {
      // The judgement was withdrawn by a verifier or reaped after its grace.
      // It will never be paid, so the case is closed rather than queued. The
      // mirror below is the caller's to write, hence `mirroredByCaller`.
      await this.voidCase(
        proposal,
        { status: mirrored, lastError: null, mirroredByCaller: true },
        'the on-chain judgement was cancelled or expired',
      );
    }

    // One statement, and it has to be: `chk_slash_proposals_chain_pending_is_whole`
    // refuses a `PENDING` or `EXECUTED` mirror without both of the chain's own
    // clocks, so writing the status first and the clocks after would be
    // rejected rather than merely untidy.
    try {
      await this.proposals.update(
        { organizationId: proposal.organizationId, id: proposal.id },
        {
          chainStatus: mirrored,
          chainProposedAt: result.proposedAt,
          chainExecutableAt: result.executableAt,
          chainReserved: result.reservedMinor,
          // Empty on the adopt path — the record exists, this process did not
          // put it there, and inventing a signature would put a transaction in
          // the timeline that nobody can look up.
          chainProposalSignature: result.signature || null,
          chainLastError: null,
        },
      );
    } catch (error) {
      // On every path but one, this write IS the work: failing it must leave
      // the row `PROPOSING` and let the caller mark it retryable, which is
      // exactly true.
      if (mirrored !== ChainProposalStatus.CANCELLED) throw error;

      // The exception: `voidCase` above has already committed `CANCELLED`, and
      // that status is outside `CHAIN_PROPOSABLE_STATUSES` — outside both the
      // sweep's SELECT and the claim's `caseStatusIn` guard. Re-throwing would
      // stamp `chain_last_error = 'transport'`, an error that means "will be
      // retried", onto a row nothing can reach. The case is closed and correct;
      // only its `chain_status` is stale, and nothing acts on the mirror of a
      // closed case.
      this.logger.error(
        `slash proposal ${proposal.id} was cancelled from the chain's own record but its ` +
          `chain mirror write failed; the case is CANCELLED with a stale chain_status`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    // Everything the chain had to say is now on the row, so nothing past this
    // point may re-classify the attempt as a failure. A timeline entry that
    // does not append is a lost annotation; letting it throw would send the
    // caller's catch-all to stamp `chain_last_error = 'transport'` over a row
    // whose `chain_status` the chain itself just decided.
    try {
      await this.lifecycle.appendEventDirect({
        organizationId: proposal.organizationId,
        proposalId: proposal.id,
        occurredAt: result.proposedAt,
        kind: result.adopted ? 'CHAIN_PROPOSAL_ADOPTED' : 'CHAIN_PROPOSED',
        actorType: 'system',
        actorId: null,
        summary:
          mirrored === ChainProposalStatus.PENDING
            ? `${result.reservedMinor} of stake is reserved on chain; nothing can execute before ` +
              `${result.executableAt.toISOString()}`
            : `The on-chain record for this judgement is already ${result.status}; the request ` +
              `id is spent and no second proposal can ever be written for it`,
        detail: {
          signature: result.signature || null,
          requestId: proposal.chainRequestId,
          recordStatus: result.status,
          executableAt: result.executableAt.toISOString(),
          reserved: result.reservedMinor,
          adopted: result.adopted,
        },
      });
    } catch (error) {
      this.logger.error(
        `slash proposal ${proposal.id} was mirrored as ${mirrored} but its timeline entry failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    if (mirrored === ChainProposalStatus.EXECUTED) {
      // The money already moved. Cancelling the case would tell the provider a
      // penalty was dropped that was in fact taken, and re-proposing is
      // impossible, so the row records what the chain says and stops.
      //
      // The parked row is `chain_status = 'EXECUTED'` with `executed_at IS
      // NULL` — a pair no other path can produce, and the predicate the
      // reconcile sweep selects it on. At `error` because a judgement
      // executing without this platform recording it is not a state any
      // healthy deployment reaches.
      this.logger.error(
        `slash proposal ${proposal.id} found an already-EXECUTED record on chain for request ` +
          `${proposal.chainRequestId}; the case is parked for reconciliation`,
      );
    }

    // Belt and braces, and it catches the one case the pre-check provably
    // cannot: an ADOPTED record. `propose()` returns whatever already sits at
    // the PDA, and its `proposed_at` may be days old, so its door can be older
    // than anything derivable from `now` — including a door that has already
    // opened. The pre-check reasons forward from this tick; only the record
    // itself can say what was actually written.
    //
    // Nothing is undone here. The mirror above is the truth about what is on
    // chain and must stand; `cancel_slash`-and-re-propose from inside the sweep
    // would burn a transaction a minute in a loop, and `findChainExecutable`
    // already waits on `max(both clocks)` so THIS process will not execute
    // early. What is left is the stranger, whom no code in this repository can
    // reach — so the row is parked loudly and a human is told, which is the
    // whole of the available remedy.
    if (
      mirrored === ChainProposalStatus.PENDING &&
      result.executableAt.getTime() < proposal.earliestExecutionAt.getTime()
    ) {
      this.logger.error(
        `slash proposal ${proposal.id} now stands on chain with a door at ` +
          `${result.executableAt.toISOString()}, BEFORE the ` +
          `${proposal.earliestExecutionAt.toISOString()} this platform promised the provider ` +
          `as the earliest execution time. execute_slash is permissionless, so anybody may ` +
          `take the penalty inside a ` +
          `window the provider was told was theirs. This process will not execute early, but it ` +
          `cannot stop a stranger: cancel the record (S-1) if the promise is to be kept.`,
      );
    }

    // The claim's `caseStatusIn` guard stops a closed case being PROPOSED. It
    // cannot stop a case being closed while this proposal was in flight: the
    // suspension or overturn then found `PROPOSING`, had nothing to cancel, and
    // the mirror above has just written `PENDING` on a row whose case is over.
    // Ask for the cancel now rather than leave it for the next tick's repair.
    if (mirrored === ChainProposalStatus.PENDING || mirrored === ChainProposalStatus.DISPUTED) {
      await this.requestCancelIfClosed(proposal);
    }

    return mirrored;
  }

  /**
   * Ask for the admin cancel when the case behind a freshly mirrored `PENDING`
   * record has already been closed without a penalty.
   *
   * Never throws, for the reason given above its call site: the chain has
   * spoken and the mirror is written. A failure here is repaired by
   * {@link requestCancelsForClosedCases} on the next tick.
   */
  private async requestCancelIfClosed(proposal: SlashProposalEntity): Promise<void> {
    try {
      const current = await this.proposals.findOneScoped(proposal.organizationId, proposal.id);
      if (!current) return;
      if (!(CLOSED_WITHOUT_PENALTY_STATUSES as readonly string[]).includes(current.status)) return;
      await this.requestAdminCancel(
        proposal.organizationId,
        proposal.id,
        `the case was already ${current.status} when its proposal confirmed`,
      );
    } catch (error) {
      this.logger.error(
        `slash proposal ${proposal.id} could not be checked for a closure that raced its proposal`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** The one-judgement path: one beneficiary on the row, one record on chain. */
  private async proposeSingle(proposal: SlashProposalEntity) {
    if (!this.executor) {
      throw SlashErrors.notExecuted({ status: 'no slash executor is configured' });
    }
    // EVM has no single-beneficiary rule. The only EVM path is the pro-rata
    // one; a case that reaches here on eip155 (call-level, or an older row
    // whose stamped beneficiary may be the escrow contract — which credits
    // nobody) is refused before anything is signed, whatever the row says.
    if (namespaceOf(proposal.assetId as AssetId) === ChainNamespace.EIP155) {
      throw SlashErrors.beneficiaryUnsupported({
        chainId: chainIdOf(proposal.assetId as AssetId),
        reason: 'EVM cases are paid pro rata per window; no call-level beneficiary rule exists',
      });
    }
    // Resolved and persisted BEFORE anything is signed, because `beneficiary` is
    // a field of the signed attestation: a row that learned it afterwards could
    // not say who the judgement it authorised actually named.
    const beneficiaryAccount =
      proposal.beneficiaryAccount ?? (await this.resolveBeneficiary(proposal));
    if (!beneficiaryAccount) {
      // Deliberately a throw and not a void. A composition with no resolver
      // cannot name who the compensating share is owed to, which is a fact
      // about this process rather than about the judgement — the case stays
      // live and a scheduler that has the resolver picks it up.
      throw SlashErrors.noBeneficiary();
    }

    return this.executor.propose({
      chainId: chainIdOf(proposal.assetId as AssetId),
      requestId: proposal.chainRequestId,
      // The provider's **stake authority**, not their id: the port hands this
      // straight to `address()`, which throws on a uuid.
      provider: await this.stakeAuthorityOf(proposal),
      // The column is CAIP-10; the port takes the bare address.
      beneficiary: bareAddress(beneficiaryAccount),
      penaltyMinor: proposal.penaltyAmount,
      policy: proposal.toolId,
      responseClass: 'dataFail',
    });
  }

  /**
   * What the chain says this case's judgement is — one record, or the fold of
   * a partitioned case's per-agent records. Every recovery path reads through
   * this, so a partitioned case is reconciled exactly like a single one.
   */
  private async readCaseRecord(proposal: SlashProposalEntity): Promise<SlashRecordSnapshot | null> {
    const provider = await this.stakeAuthorityOf(proposal);
    if (this.parts?.appliesTo(proposal)) return this.parts.readRecord(proposal, provider);
    if (!this.executor) {
      throw SlashErrors.notExecuted({ status: 'no slash executor is configured' });
    }
    return this.executor.readRecord(
      proposal.chainRequestId,
      provider,
      chainIdOf(proposal.assetId as AssetId),
    );
  }

  /**
   * The chain says this judgement will never be paid. Close the case.
   *
   * `AUTO_CHAIN_VOIDED` and **no** `outcome` of its own, on the same rule the
   * other three automatic kinds follow: nobody adjudicated it, and recording an
   * adjudicator's verdict on a case no human read would corrupt the taxonomy
   * our own false-positive rate is measured from. An outcome that is already there
   * is left exactly as it was — the human's judgement stands, and only the
   * *closure* was automatic.
   *
   * It does **not** count as a false positive. The judgement may have been
   * perfectly sound — a revoked verifier key voids it for reasons that have
   * nothing to do with whether the provider failed.
   *
   * ## Nothing after the transition may throw
   *
   * The transition is the commit point, and `CANCELLED` is terminal: it is
   * outside `CHAIN_PROPOSABLE_STATUSES`, which is both the sweep's `SELECT`
   * predicate **and** the claim's `caseStatusIn` guard. So a row whose case has
   * closed can never be selected or claimed again — and an exception escaping
   * this method after that point would travel to `proposeDue`'s catch-all,
   * which would stamp `chain_last_error = 'transport'`: an error whose whole
   * meaning is "this will be retried", written onto a row nothing can reach.
   *
   * Hence one guard around the mirror write, the timeline entry and the
   * notification together. None of the three is worth converting a committed
   * state transition into an unreachable row, and all three are recoverable by
   * a human reading the log line the guard emits.
   *
   * @param chain what the chain mirror says. Written here unless
   *   `mirroredByCaller` — the adopt paths write it themselves, *after* this
   *   returns, so that a crash in between leaves the case closed rather than
   *   left open behind an unreachable mirror. Either way these are the values
   *   the timeline entry reports, never a re-read of the passed-in entity,
   *   which `update()` does not refresh.
   */
  private async voidCase(
    proposal: SlashProposalEntity,
    chain: {
      readonly status: ChainProposalStatus;
      readonly lastError: string | null;
      /** The caller writes the mirror itself; skip the write, keep the values. */
      readonly mirroredByCaller?: boolean;
    },
    because: string,
  ): Promise<void> {
    // One clock for the closure and its timeline entry. Two `new Date()` calls
    // would put `resolved_at` and `occurred_at` milliseconds apart, and a case
    // page that orders a timeline against the row's own resolution would show
    // the closure landing before the case closed.
    const now = new Date();

    // `status`, `resolutionKind`, `resolvedAt` and `countsAsFalsePositive` move
    // in ONE statement. `chk_slash_proposals_resolution_is_whole` demands
    // `(resolved_at IS NULL) = (resolution_kind IS NULL)`, so a write that set
    // the kind and left the timestamp for a second statement would be refused
    // by the database rather than merely be untidy.
    const affected = await this.proposals.transitionIfIn(
      proposal.organizationId,
      proposal.id,
      CHAIN_VOIDABLE_STATUSES,
      {
        status: SlashProposalStatus.CANCELLED,
        resolutionKind: ResolutionKind.AUTO_CHAIN_VOIDED,
        resolvedAt: now,
        countsAsFalsePositive: false,
      },
    );
    // Past this line the case is closed and nothing may throw. See the method
    // header: an escaping exception would have `proposeDue` mark an unreachable
    // row as retryable.
    try {
      // The mirror is second now, not first. If it fails, the case is still
      // correctly closed and only its `chain_status` is stale — whereas
      // mirroring first and failing here would leave the case OPEN behind a
      // `chain_status` no sweep predicate admits, which is the worse half of
      // the same trade. Written even when the transition lost, because what
      // the chain said is a fact about the judgement regardless of who closed
      // the case.
      if (!chain.mirroredByCaller) {
        await this.proposals.update(
          { organizationId: proposal.organizationId, id: proposal.id },
          { chainStatus: chain.status, chainLastError: chain.lastError },
        );
      }

      // Somebody else already closed it — an overturn, a sweep, a waiver. Their
      // resolution is the true one and this must not append a second closure to
      // the timeline or tell the provider twice.
      if (affected > 0) {
        await this.lifecycle.appendEventDirect({
          organizationId: proposal.organizationId,
          proposalId: proposal.id,
          occurredAt: now,
          kind: 'CHAIN_VOIDED',
          actorType: 'system',
          actorId: null,
          summary: `Cancelled: ${because}`,
          detail: {
            chainError: chain.lastError,
            chainStatus: chain.status,
            requestId: proposal.chainRequestId,
            because,
          },
        });

        // What the provider is told about their *stake* depends on what the
        // mirror says, because the two cases are opposites and the money is
        // theirs. See `reservationReleasedBy`.
        const heldUntil = this.reservationHeldUntil(proposal, chain.status);

        await this.notifications.notify({
          organizationId: proposal.organizationId,
          event: NotificationEvent.PROVIDER_SLASH_DECIDED,
          title: 'A proposed penalty against your stake was cancelled',
          // No program error name on the provider's screen. `VerifierRevoked`
          // is our incident, not their vocabulary; the name is in the timeline
          // entry and the log, which is where an operator reads.
          body:
            'The penalty could not be applied on chain, so it is cancelled and nothing was ' +
            'taken. ' +
            (heldUntil
              ? `The on-chain record still holds the stake it reserved. Nothing can be taken ` +
                `from that reservation now, and it is released when the record expires after ` +
                `${heldUntil.toISOString()}.`
              : 'Any stake it had reserved is released.'),
          subjectType: SLASH_PROPOSAL_SUBJECT_TYPE,
          subjectId: proposal.id,
          dedupeKey: `${proposal.id}:decided`,
          payload: {
            proposalId: proposal.id,
            chainError: chain.lastError,
            // Null when the reservation is already released, so the case page
            // can render the same distinction without re-deriving it.
            reservationHeldUntil: heldUntil?.toISOString() ?? null,
          },
        });
      }
    } catch (error) {
      this.logger.error(
        `slash proposal ${proposal.id} was voided (${because}) but recording it failed; the ` +
          `case is CANCELLED and its chain mirror or timeline may be incomplete`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    if (affected === 0) return;

    // At `warn`. A void is not routine: the two commonest causes are a verifier
    // key that was revoked (an incident) and a judgement larger than the
    // provider's contract (a formula bug). Both want a human.
    this.logger.warn(`slash proposal ${proposal.id} voided by the chain: ${because}`);
  }

  /**
   * When a voided case's on-chain reservation is actually released — or `null`
   * when there is nothing left holding it.
   *
   * The distinction is the provider's money, and the two cases are opposites:
   *
   * - `REFUSED` — the program refused `propose_slash`, so **no record exists**
   *   and nothing was ever reserved.
   * - `CANCELLED` — `cancel_slash` or `expire_slash` ran, and the program
   *   releases the reservation in the same instruction.
   * - `PENDING` — the record is standing, `Pending`, with the stake still
   *   reserved. This is the chain-void case: a `VerifierRevoked` or
   *   `VerifierKeyExpired` void at *execution* time closes our case and leaves
   *   the chain's record exactly where it was. Nothing can spend it — the
   *   judgement is dead — but the reservation stands until somebody calls
   *   `expire_slash`, which becomes permissionless at
   *   `executable_at + SLASH_EXECUTION_GRACE_SECONDS`.
   *
   * Returning the horizon rather than a boolean because a provider whose
   * capital screen is short by a reserved amount needs the date, not the fact.
   * `null` for a `PENDING` mirror with no `chain_executable_at` is unreachable
   * (`chk_slash_proposals_chain_pending_is_whole` demands it) and degrades to
   * the shorter, still-true sentence rather than printing `Invalid Date`.
   */
  private reservationHeldUntil(
    proposal: SlashProposalEntity,
    chainStatus: ChainProposalStatus,
  ): Date | null {
    if (chainStatus === ChainProposalStatus.DISPUTED && proposal.chainDisputedAt) {
      return new Date(proposal.chainDisputedAt.getTime() + DISPUTE_TIMEOUT_MS);
    }
    if (chainStatus !== ChainProposalStatus.PENDING) return null;
    if (!proposal.chainExecutableAt) return null;
    return new Date(proposal.chainExecutableAt.getTime() + SLASH_EXECUTION_GRACE_MS);
  }

  /**
   * Take the penalty for every judgement both clocks agree is payable.
   *
   * This is where money actually moves. Slashing is a lifecycle,
   * `propose_slash` → 72h → `execute_slash`, and this is phase two: the
   * penalty, the policy and the split were all signed by a verifier three days
   * ago and live on the `SlashRecord`, so `execute_slash` is consulted about
   * nothing except whether the key that signed is still allowed to sign.
   *
   * ## Two clocks, and it waits on both
   *
   * `earliest_execution_at` is stamped `proposed_at + timelockMs` when the ROW
   * is created — it is the case screen's promise to the provider. It is **not**
   * immutable: `ArbitrationService.extendDeadline` (`S-8`) moves it forward, and
   * an earlier version of this comment claiming it never moves was the reason
   * that path went unguarded.
   * `chain_executable_at` is `SlashRecord.proposed_at + Config.slash_delay_seconds`,
   * read off the account, and it is what the program actually enforces. They
   * are not the same number and the chain's is normally the later one, because
   * the record cannot be proposed before the row exists — but "normally" is
   * carrying weight there, which is why the wait is on `max(…)` and not on the
   * chain's clock alone, and why {@link proposeDue} will not write a record
   * whose door would open before the promise.
   *
   * The wait is on `max(…)` of the two, and it is spelled in
   * {@link SlashProposalRepository.findChainExecutable}'s `WHERE` rather than
   * here: both comparisons live in one predicate that the partial index
   * supports, and a row that is not due is never loaded. Two CHECK constraints
   * (`…execution_respects_timelock`, `…execution_respects_chain_timelock`)
   * refuse the write independently, so a caller that forgot either clock is
   * stopped by the database rather than by a code review.
   *
   * ## The three counters
   *
   * - `executed` — the chain took the penalty.
   * - `voided` — the judgement is dead and the case is closed. A revoked
   *   verifier key is the designed case, not a fault.
   * - `failed` — anything else. The case is left where the next tick or the
   *   reconciler can pick it up; see the catch for which of the two, and why
   *   that choice is the sharpest thing in this method.
   *
   * **They count what the chain did, not what the compare-and-swap did**, and
   * the same rule governs {@link reconcileExecuting}'s three. A `completeExecution`
   * or a `voidCase` whose CAS affected zero rows means somebody else moved the
   * case in the interval — an operator suspension, an overturn — and it changes
   * what the *row* says. It does not change the fact that a penalty was taken,
   * or that a judgement is dead, and a pass that reported otherwise would be
   * reporting on a race rather than on the chain. Each of those methods logs at
   * `error` when it loses, and skips its own timeline entry and notification so
   * a second closure is never announced.
   */
  async executeDue(now: Date = new Date()): Promise<{
    executed: number;
    voided: number;
    failed: number;
  }> {
    if (!this.executor) {
      throw SlashErrors.notExecuted({ status: 'no slash executor is configured' });
    }

    const due = await this.proposals.findChainExecutable(now, this.config.sweepBatchSize);
    let executed = 0;
    let voided = 0;
    let failed = 0;
    const batch: { proposal: SlashProposalEntity; provider: string }[] = [];

    for (const candidate of due) {
      const proposal = await this.proposals.findOneScoped(candidate.organizationId, candidate.id);
      if (!proposal) continue;

      // Already diagnosed, once, loudly. See `EXECUTED_BEYOND_DECISION`.
      //
      // **This `continue` is a mitigation and not a solution, and the next
      // reader should not mistake it for one.** The row keeps
      // `chain_status = 'PENDING'` and `status = 'UPHELD'`, which is exactly
      // `findChainExecutable`'s predicate — so it is re-selected and re-read
      // from the database on every single tick, for ever, and it permanently
      // occupies one of `sweepBatchSize` slots that a live judgement could have
      // used. What the skip buys is the expensive half: no `cancel_slash`, no
      // `readRecord`, no signing, and no second log line saying the same thing
      // once a minute.
      //
      // Draining it properly needs the state to be representable — a column or
      // a status rather than a diagnostic string — which is a migration, and
      // this lane's migration is already written and verified against a real
      // Postgres. Recorded as deferred work rather than bolted on here.
      if (proposal.chainLastError === EXECUTED_BEYOND_DECISION) continue;

      try {
        // Inside the per-row `try`, not before it. A malformed amount throwing
        // out of the comparison would otherwise abort the whole batch and hold
        // every other provider's harmed agent out of their compensation — the
        // opposite of the isolation the rest of this loop is built on.
        //
        // The last line of defence for the figure a human decided. See
        // `theStandingRecordMayTakeMoreThanWasDecided`.
        if (this.theStandingRecordMayTakeMoreThanWasDecided(proposal)) {
          this.logger.error(
            `slash proposal ${proposal.id} is due but its on-chain record reserved ` +
              `${proposal.chainReserved ?? 'an unrecorded amount'} against a penalty of ` +
              `${proposal.penaltyAmount}; re-proposing at the decided figure instead of executing`,
          );
          await this.reproposeAtRevisedPenalty(proposal.organizationId, proposal.id, now);
          // Uncounted on purpose: nothing was executed, nothing was voided and
          // nothing failed. The counters report what the chain did to a
          // judgement, and this one has not reached the chain in its decided
          // form yet.
          continue;
        }

        if (this.parts?.appliesTo(proposal)) {
          // Partitioned: claimed now, executed below in ONE batch with every
          // other due case's parts.
          const claim = await this.claimForExecution(proposal, now);
          if (claim) batch.push(claim);
          continue;
        }

        const took = await this.executeOne(proposal, now);
        if (took) executed += 1;
      } catch (error) {
        if ((await this.recordExecuteFailure(proposal, error, now)) === 'voided') voided += 1;
        else failed += 1;
      }
    }

    if (batch.length > 0 && this.parts) {
      let outcomes: Map<string, { ok: boolean; result?: SlashExecutionResult; error?: unknown }>;
      try {
        outcomes = await this.parts.executeMany(batch);
      } catch (error) {
        // Nothing is known about any of them; the transport rule applies to
        // all — they stay EXECUTING and the reconciler reads their records.
        outcomes = new Map(batch.map((entry) => [entry.proposal.id, { ok: false, error }]));
      }
      for (const { proposal } of batch) {
        const outcome = outcomes.get(proposal.id) ?? {
          ok: false,
          error: SlashErrors.notExecuted({ status: 'the batch returned no outcome for the case' }),
        };
        try {
          if (outcome.ok && outcome.result) {
            await this.completeExecution(proposal, outcome.result, [SlashProposalStatus.EXECUTING]);
            await this.compensate(proposal, outcome.result);
            executed += 1;
            continue;
          }
          throw outcome.error;
        } catch (error) {
          if ((await this.recordExecuteFailure(proposal, error, now)) === 'voided') voided += 1;
          else failed += 1;
        }
      }
    }

    return { executed, voided, failed };
  }

  /**
   * What a failed execution means for its case — the one rule, shared by the
   * single path and the partitioned batch. See the long comments inside: a
   * permanent refusal voids the case unless the record must be read first; a
   * named program refusal returns it to `UPHELD`; anything unnamed leaves it
   * `EXECUTING` for the reconciler, because the transaction may have landed.
   */
  private async recordExecuteFailure(
    proposal: SlashProposalEntity,
    error: unknown,
    now: Date,
  ): Promise<'voided' | 'failed'> {
    // Classified from the error itself, never from a name parsed out of a
    // message, and the name is resolved from the numeric code against the
    // vendored IDL — the program's error enum is not append-only.
    const name = chainErrorName(error);
    const kind = classifyChainFailure(error);

    if (kind === ChainFailureKind.VOID && !EXECUTE_MUST_READ_THE_RECORD.has(name ?? '')) {
      try {
        await this.voidCase(
          proposal,
          {
            // NOT `REFUSED`. The record is sitting on chain in `Pending`
            // and stays there until somebody expires it; `REFUSED` is
            // documented as "no record exists and none will", which would
            // be a lie about a record that plainly does. What the mirror
            // says about the record is unchanged by our failing to spend
            // it — only `chain_last_error` learns anything.
            status: proposal.chainStatus as ChainProposalStatus,
            lastError: name ?? 'unknown',
          },
          `the settlement program refused to execute it (${name ?? 'unnamed refusal'})`,
        );
        // Counted whether or not `voidCase` won its CAS — the counting
        // rule in this method's header.
        return 'voided';
      } catch (voidError) {
        // `voidCase` guards everything after its own transition, so only
        // the transition itself can reach here — which means nothing
        // committed and the case is untouched. Count it retryable, and
        // above all do not end the pass: one provider's database blip must
        // not hold every other provider's harmed agent out of their
        // compensation.
        this.logger.error(
          `slash proposal ${proposal.id} could not be voided after a permanent refusal`,
          voidError instanceof Error ? voidError.stack : String(voidError),
        );
        return 'failed';
      }
    }

    // The one distinction this catch turns on, and it decides whether a
    // provider can be told their penalty was cancelled when it was taken.
    //
    // A **named** custom program error means the settlement program ran and
    // reverted the transaction: nothing moved, the record is still exactly
    // as it was, and the case is safe to put back in the queue for the next
    // tick. The caps that produce most of these — the per-key and
    // per-provider 24h windows — drain continuously, so a later tick really
    // can pay what this one could not.
    //
    // **No name** means the program never spoke: an RPC failure, an expired
    // blockhash, a confirmation timeout. The transaction may have landed.
    // Returning the case to `UPHELD` there would have the next tick
    // re-submit, collect `SlashNotPending` from a record that is now
    // `Executed`, and — before `EXECUTE_MUST_READ_THE_RECORD` above — close
    // the case as cancelled. So the row stays `EXECUTING` with its claim
    // standing, which is precisely the state `reconcileExecuting` exists to
    // resolve by reading the record instead of guessing.
    const programSpoke = name !== null && !EXECUTE_MUST_READ_THE_RECORD.has(name);

    // Guarded for the same reason the VOID branch above is, and it is the
    // same rule: a database blip on one provider's row must not end the
    // pass and hold every other provider's harmed agent out of their
    // compensation. Both writes here are recoverable without it — a failed
    // return to `UPHELD` leaves the row `EXECUTING` and claimed, which the
    // reconciler resolves by reading the record, and a failed
    // `chain_last_error` loses a diagnostic.
    try {
      if (programSpoke) {
        await this.proposals.transitionIfIn(
          proposal.organizationId,
          proposal.id,
          [SlashProposalStatus.EXECUTING],
          { status: SlashProposalStatus.UPHELD, chainClaimedAt: null },
        );
      }

      await this.proposals.update(
        { organizationId: proposal.organizationId, id: proposal.id },
        // The program's own name, or `'transport'` for every failure it did
        // not name — including a local refusal before anything was sent.
        { chainLastError: name ?? 'transport' },
      );
    } catch (writeError) {
      this.logger.error(
        `slash proposal ${proposal.id} failed to execute AND could not be marked; it stays ` +
          `${programSpoke ? 'EXECUTING for the reconciler' : 'as it was'}`,
        writeError instanceof Error ? writeError.stack : String(writeError),
      );
    }

    this.warnIfGraceIsRunningOut(proposal, now, name);
    this.logger.error(
      `execute_slash failed for proposal ${proposal.id}`,
      error instanceof Error ? error.stack : String(error),
    );
    return 'failed';
  }

  /**
   * `UPHELD → EXECUTING` for a partitioned case, after the checks that can
   * fail without touching the chain — the same claim `executeOne` takes, for
   * the same reasons. `null` when another replica holds it.
   */
  private async claimForExecution(
    proposal: SlashProposalEntity,
    now: Date,
  ): Promise<{ proposal: SlashProposalEntity; provider: string } | null> {
    const provider = await this.stakeAuthorityOf(proposal);
    const claimed = await this.proposals.transitionIfIn(
      proposal.organizationId,
      proposal.id,
      [SlashProposalStatus.UPHELD],
      { status: SlashProposalStatus.EXECUTING, chainClaimedAt: now },
    );
    return claimed === 0 ? null : { proposal, provider };
  }

  /**
   * A judgement the caps keep refusing has a deadline of its own.
   *
   * {@link SLASH_EXECUTION_GRACE_MS} after the chain's `executable_at`, anybody
   * may `expire_slash` the record and the judgement can never be executed — the
   * penalty is discharged and the harmed agent is never compensated. That is
   * seven days to find out why the per-key or per-provider cap keeps biting,
   * and a line on the last of them is the only warning anybody gets.
   *
   * At `warn` rather than `error`: it is a deadline approaching, not a failure
   * that has happened, and the pass itself already logs the refusal at `error`.
   */
  private warnIfGraceIsRunningOut(
    proposal: SlashProposalEntity,
    now: Date,
    errorName: string | null,
  ): void {
    if (!proposal.chainExecutableAt) return;
    const burned = now.getTime() - proposal.chainExecutableAt.getTime();
    if (burned < GRACE_WARNING_MS) return;

    const expiresAt = new Date(proposal.chainExecutableAt.getTime() + SLASH_EXECUTION_GRACE_MS);
    this.logger.warn(
      `slash proposal ${proposal.id} has burned ${Math.floor(burned / 86_400_000)} days of its ` +
        `7-day execution grace on ${errorName ?? 'transport failures'}; after ` +
        `${expiresAt.toISOString()} anybody may expire_slash it and it can never be executed`,
    );
  }

  /**
   * Read the chain for every case whose submitting process died, and record
   * what it actually says. The reconcile sweep.
   *
   * ## Why it reads rather than retries
   *
   * `EXECUTING` exists for exactly the interval between sending a transaction
   * and learning whether it landed. The old code resolved that interval by
   * returning the case to `UPHELD` and letting the next tick re-submit, on the
   * reasoning that the chain's `request_id` lock made a retry safe. It no
   * longer does: the lock is spent at *proposal* time, so a
   * re-submitted `execute_slash` against an already-executed record answers
   * `SlashNotPending` — and every reading of that answer except "go and look"
   * is a guess about whether a provider's money moved.
   *
   * So the record is the only source, and it carries everything the row needs:
   * `status`, `applied`, `agent_amount`, `platform_amount` and `executed_at`.
   *
   * ## The two shapes it picks up
   *
   * - An orphaned `EXECUTING` claim — the crash case above.
   * - The **adopted-`EXECUTED` park**: `proposeDue` found a record already
   *   `Executed` at a request id whose row had never been told, mirrored
   *   `chain_status = 'EXECUTED'` and deliberately left the case alone rather
   *   than cancelling a penalty that had in fact been taken. That row is
   *   outside both of the other sweeps' predicates, so this is the only thing
   *   that will ever reach it — and it must, because the money moved and the
   *   agent has not been compensated.
   *
   * The three counters are about the *record*, not the case: `recovered` means
   * the chain says `Executed` and the row now says so too; `returned` means it
   * is still `Pending` and the case goes back in the execution queue; `voided`
   * means somebody cancelled or expired it and the judgement is dead.
   */
  async reconcileExecuting(now: Date = new Date()): Promise<{
    recovered: number;
    returned: number;
    voided: number;
  }> {
    if (!this.executor) {
      throw SlashErrors.notExecuted({ status: 'no slash executor is configured' });
    }

    const stale = await this.proposals.findExecutingToReconcile(
      new Date(now.getTime() - CHAIN_CLAIM_STALE_MS),
      this.config.sweepBatchSize,
    );

    let recovered = 0;
    let returned = 0;
    let voided = 0;

    for (const candidate of stale) {
      const proposal = await this.proposals.findOneScoped(candidate.organizationId, candidate.id);
      if (!proposal) continue;

      // Which of the two shapes this row is. An `EXECUTING` row is an
      // interrupted attempt of ours; anything else here is a park, whose case
      // never entered the execution states at all.
      //
      // Read once, into a local: `transitionIfIn` does not refresh the entity
      // it was handed, so re-reading `proposal.status` after the write would be
      // reading whichever of the two the ORM happened to leave there.
      const caseStatus = proposal.status;
      const inFlight = caseStatus === SlashProposalStatus.EXECUTING;

      try {
        const record = await this.readCaseRecord(proposal);

        if (record?.status === 'EXECUTED') {
          const result = {
            // Deliberately null. This process never learned the signature, and
            // a fabricated one would put a transaction in the case timeline
            // that nobody can look up. `chk_slash_proposals_executed_is_whole`
            // was relaxed for exactly this: a signature still requires an
            // `executed_at`, an `executed_at` no longer requires a signature.
            signature: null,
            appliedMinor: record.appliedMinor,
            agentAmountMinor: record.agentAmountMinor,
            platformAmountMinor: record.platformAmountMinor,
            // `?? now` is unreachable for an `Executed` record — the program
            // stamps `executed_at` in the same instruction that sets the
            // status — and is here so a decoding anomaly cannot write a null
            // into a column two CHECK constraints compare against.
            executedAt: record.executedAt ?? now,
          };

          // The affected count is not consulted here either, for the reason in
          // `executeDue`'s counting rule: a lost CAS changes what the row says
          // and changes nothing about the money. The agents are owed the share
          // sitting in the vault whoever moved the case in the interval, and
          // `distribute` is idempotent on the ledger's unique index.
          await this.completeExecution(
            proposal,
            result,
            inFlight ? [SlashProposalStatus.EXECUTING] : CHAIN_PROPOSABLE_STATUSES,
          );

          if (!inFlight) {
            // A penalty was taken for a case this platform had not even
            // upheld yet. The row is now correct, and that is the end of what
            // code can do about it: whether the judgement was sound is a
            // question for a human, and it is one they have to be told about.
            this.logger.error(
              `slash proposal ${proposal.id} was executed on chain while the case was ` +
                `${caseStatus}; the row now records the penalty the chain took`,
            );
          }

          await this.compensate(proposal, {
            ...result,
            // The idempotency key for the ledger's unique index, which is what
            // makes a repeated distribution safe. `distribute` takes it as
            // `signature`; what matters is that it is stable and non-null, and
            // on this path the signature is neither.
            signature: proposal.chainRequestId,
          });
          recovered += 1;
          continue;
        }

        if (!inFlight) {
          // A park whose record does not agree it executed. Nothing in this
          // service can produce that pair, so it is either a mirror written
          // against a different cluster or a decoding fault — and writing an
          // execution on the strength of it would be inventing one.
          this.logger.error(
            `slash proposal ${proposal.id} is mirrored EXECUTED but its on-chain record reads ` +
              `${record?.status ?? 'absent'}; left for a human`,
          );
          continue;
        }

        if (!record || record.status === 'PENDING' || record.status === 'DISPUTED') {
          // Either the transaction never landed or it landed and failed. The
          // judgement is alive; put the case back in the queue and release the
          // claim so the next `executeDue` can take it. A record the provider
          // DISPUTED (D-19) is alive too: the mirror says so, which keeps it
          // out of the execute sweep until the arbiter's uphold lands.
          await this.proposals.transitionIfIn(
            proposal.organizationId,
            proposal.id,
            [SlashProposalStatus.EXECUTING],
            {
              status: SlashProposalStatus.UPHELD,
              chainClaimedAt: null,
              ...(record?.status === 'DISPUTED'
                ? {
                    chainStatus: ChainProposalStatus.DISPUTED,
                    chainDisputedAt: record.disputedAt ?? null,
                  }
                : {}),
            },
          );
          returned += 1;
          continue;
        }

        // `CANCELLED` — a verifier withdrew the judgement, or it was reaped
        // after its grace. The reservation is released and no execution can
        // ever follow.
        await this.voidCase(
          proposal,
          { status: ChainProposalStatus.CANCELLED, lastError: null },
          'the on-chain judgement was cancelled or expired',
        );
        voided += 1;
      } catch (error) {
        // Nothing is written on this path, so the row keeps its claim and the
        // next pass reads the record again. One unreadable account must not
        // end the sweep.
        this.logger.error(
          `reconciling proposal ${proposal.id} failed`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    await this.sweepStrandedParts(now);

    return { recovered, returned, voided };
  }

  /**
   * A partitioned case can close as EXECUTED with a part still PENDING on
   * chain — a dead part (revoked key) whose `expireSlash` failed or was not
   * allowed yet. Its reservation holds the provider's stake, so the reconcile
   * pass revisits it every tick until the chain releases it. Never throws.
   */
  private async sweepStrandedParts(now: Date): Promise<void> {
    if (!this.parts) return;
    try {
      const rows = await this.parts.findCasesWithStrandedParts(this.config.sweepBatchSize);
      const cases: { proposal: SlashProposalEntity; provider: string }[] = [];
      for (const row of rows) {
        const proposal = await this.proposals.findOneScoped(row.organizationId, row.proposalId);
        if (proposal) cases.push({ proposal, provider: await this.stakeAuthorityOf(proposal) });
      }
      if (cases.length === 0) return;
      // The pass's own clock: the same instant every other decision this tick
      // is made against.
      const swept = await this.parts.sweepStrandedParts(cases, now);
      // A late part paid now: the closed case's money columns follow the chain.
      for (const id of swept.executedCases) {
        const entry = cases.find((candidate) => candidate.proposal.id === id);
        if (!entry) continue;
        const view = await this.parts.readRecord(entry.proposal, entry.provider);
        if (!view) continue;
        await this.proposals.update(
          { organizationId: entry.proposal.organizationId, id },
          { appliedAmount: view.appliedMinor, platformAmount: view.platformAmountMinor },
        );
        this.logger.warn(
          `slash case ${id}: a late part executed; the case now records ${view.appliedMinor} applied`,
        );
      }
      if (swept.expired > 0 || swept.executed > 0) {
        this.logger.warn(
          `stranded slash parts: ${swept.executed} executed, ${swept.expired} expired, ` +
            `${swept.waiting} not yet due`,
        );
      }
    } catch (error) {
      this.logger.error(
        'sweeping stranded slash parts failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Record that a standing on-chain proposal should be withdrawn, and wait for
   * the admin.
   *
   * The reservation is not bookkeeping: `ProviderStake::withdrawable` is
   * `min(matured unbonding, bonded + unbonding − pending_slash)`, so a standing
   * proposal is capital the provider cannot move. A case they *won* must not go
   * on costing them that.
   *
   * ## Why this no longer cancels anything
   *
   * `cancel_slash` takes `Config.admin` as its only signer, and that
   * key is a person's. There is no signature this process can produce, so the
   * whole of what it can do is move the mirror to
   * {@link ChainProposalStatus.CANCEL_REQUESTED} and leave the case for
   * {@link buildCancelIntent} and a human. Two things then finish the job
   * without anybody watching:
   *
   * - {@link sweepAdminCancels} mirrors `CANCELLED` once the admin's
   *   transaction lands, and
   * - the same sweep calls the permissionless `expire_slash` once the record's
   *   seven-day grace after `executable_at` has run, so a request the admin
   *   never got to still releases the provider's stake.
   *
   * `CANCEL_REQUESTED` is a distinct status rather than a flag because
   * `findChainExecutable` selects on `chain_status = 'PENDING'`: a case in this
   * state falls out of the execute sweep by construction, so this platform
   * cannot execute a judgement it has already withdrawn. It cannot stop a
   * *stranger* — `execute_slash` is permissionless once `executable_at` passes
   * — which is exactly what the expiry half is for.
   *
   * ## Why it never throws
   *
   * Most of its callers reach it *after* a transaction has committed —
   * `ArbitrationService.decide`, `second()` and `suspend()` — and the rest are
   * cron ticks sweeping a batch. An exception here would hand an operator a
   * failure for a decision that stands, which they would then make again.
   *
   * Returns whether it recorded a request, so a sweep can count what it did.
   */
  async requestAdminCancel(
    organizationId: string,
    proposalId: string,
    reason: string,
  ): Promise<boolean> {
    let proposal: SlashProposalEntity | null;
    try {
      proposal = await this.proposals.findOneScoped(organizationId, proposalId);
    } catch (error) {
      this.logger.error(
        `slash proposal ${proposalId} could not be read to request its chain cancellation`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
    // `PENDING` is the only mirror with a reservation behind it. `NONE` and
    // `REFUSED` never wrote a record, `CANCELLED` released one, `EXECUTED`
    // spent it, and `CANCEL_REQUESTED` has already been asked for — asking
    // again would rewrite the same row and append a second identical event.
    // `DISPUTED` (D-19) is a standing reservation too, and `cancelSlash`
    // accepts it.
    if (
      !proposal ||
      (proposal.chainStatus !== ChainProposalStatus.PENDING &&
        proposal.chainStatus !== ChainProposalStatus.DISPUTED)
    ) {
      return false;
    }

    try {
      await this.proposals.update(
        { organizationId, id: proposalId },
        { chainStatus: ChainProposalStatus.CANCEL_REQUESTED, chainLastError: null },
      );
    } catch (error) {
      this.logger.error(
        `slash proposal ${proposalId} could not be marked as awaiting an admin cancel (${reason})`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }

    // The request is recorded; a timeline entry that does not append is a lost
    // annotation, not a lost request.
    try {
      await this.lifecycle.appendEventDirect({
        organizationId,
        proposalId,
        occurredAt: new Date(),
        kind: 'CHAIN_CANCEL_REQUESTED',
        actorType: 'system',
        actorId: null,
        summary:
          `The on-chain reservation is due to be released (${reason}); ` +
          `waiting for the arbiter (or, with none appointed, the settlement admin) to sign ` +
          `cancel_slash`,
        detail: { reason, requestId: proposal.chainRequestId },
      });
    } catch (error) {
      this.logger.error(
        `slash proposal ${proposalId} is awaiting an admin cancel (${reason}) but its timeline ` +
          `entry failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
    return true;
  }

  /**
   * Ask for the cancel of every closed case whose record still mirrors
   * `PENDING` — the repair behind the best-effort requests.
   *
   * A suspension and an overturn both ask *after* their own transaction has
   * committed, so the request can be lost: the write fails, the process dies
   * between the two, or the case is closed while `propose_slash` is in flight
   * and the record lands afterwards. Such a row is selected by nothing — the
   * execute sweep wants `UPHELD`, the admin-cancel sweep wants
   * `CANCEL_REQUESTED` — while the provider's stake stays reserved and the
   * record becomes anyone's to execute once its timelock passes.
   *
   * Records the request and nothing else: no transaction is built, signed or
   * sent here. Bounded by the sweep batch size, soonest deadline first, and
   * idempotent — a marked row leaves the predicate, so a second pass finds
   * nothing. Returns how many it marked.
   */
  async requestCancelsForClosedCases(): Promise<number> {
    const rows = await this.proposals.findClosedStillPending(this.config.sweepBatchSize);
    let requested = 0;
    for (const row of rows) {
      const marked = await this.requestAdminCancel(
        row.organizationId,
        row.id,
        'the case is closed and its on-chain record was still pending',
      );
      if (marked) requested += 1;
    }
    return requested;
  }

  /**
   * The unsigned `cancel_slash` an operator carries to the admin.
   *
   * Builds only. The case is not touched: it moves to `CANCELLED` when
   * {@link sweepAdminCancels} sees the record leave `Pending`, never on the
   * strength of a transaction somebody was handed.
   */
  async buildCancelIntent(organizationId: string, proposalId: string): Promise<SlashCancelIntent> {
    if (!this.executor) {
      throw SlashErrors.chainUnavailable({ proposalId, reason: 'no settlement executor' });
    }
    const proposal = await this.proposals.findOneScoped(organizationId, proposalId);
    if (!proposal) {
      throw SlashErrors.proposalNotFound({ proposalId });
    }
    // Only for a record this platform has already decided to withdraw. A
    // `cancel_slash` built for any other case is a transaction that drops a
    // standing judgement the moment the admin signs it, on nobody's decision.
    if (proposal.chainStatus !== ChainProposalStatus.CANCEL_REQUESTED) {
      throw SlashErrors.actionNotAllowedInStatus({
        action: 'build the cancel transaction',
        status: `${proposal.status} (on-chain record ${proposal.chainStatus})`,
        allowed: "waiting for the settlement admin's cancel (CANCEL_REQUESTED)",
      });
    }
    if (this.parts?.appliesTo(proposal)) {
      // One part's cancel per request: the case stays CANCEL_REQUESTED until
      // every part has left Pending, so the next request hands out the next.
      return this.parts.buildCancel(proposal, await this.stakeAuthorityOf(proposal));
    }
    return this.executor.buildCancel({
      chainId: chainIdOf(proposal.assetId as AssetId),
      requestId: proposal.chainRequestId,
      // The provider's **stake authority**, not their id: the port hands this
      // straight to `address()`, which throws on a uuid.
      provider: await this.stakeAuthorityOf(proposal),
    });
  }

  /**
   * One pass over every case waiting on the settlement admin.
   *
   * Two outcomes, in this order:
   *
   * - **The admin signed.** The record has left `Pending`, and the mirror
   *   catches up. `CANCELLED` is what was asked for; `EXECUTED` is the case
   *   where a stranger spent the standing record first, and it is recorded as
   *   an execution nobody asked for rather than papered over.
   * - **Nobody signed, and the grace has run.** `expire_slash` is
   *   permissionless once `executable_at + SLASH_EXECUTION_GRACE_SECONDS` has
   *   passed, so this platform reaps the record itself. That is the whole
   *   answer to "what if the admin never gets to it": the provider's capital is
   *   released seven days after the judgement became executable, without a
   *   human.
   *
   * Never throws — one unreadable record must not hold every other provider's
   * released capital.
   */
  async sweepAdminCancels(now: Date = new Date()): Promise<{
    mirrored: number;
    expired: number;
    waiting: number;
  }> {
    if (!this.executor) return { mirrored: 0, expired: 0, waiting: 0 };

    const rows = await this.proposals.findAwaitingAdminCancel(this.config.sweepBatchSize);
    let mirrored = 0;
    let expired = 0;
    let waiting = 0;

    for (const row of rows) {
      try {
        const proposal = await this.proposals.findOneScoped(row.organizationId, row.id);
        if (!proposal || proposal.chainStatus !== ChainProposalStatus.CANCEL_REQUESTED) continue;

        if (await this.mirrorRecordThatLeftPending(proposal, 'ADMIN_CANCEL')) {
          mirrored += 1;
          continue;
        }

        // Still `Pending`. The expiry door opens seven days after the record
        // became executable — the program's own `SLASH_EXECUTION_GRACE_SECONDS`,
        // read from the client rather than retyped here.
        // A record the provider disputed (D-19) expires on its own clock,
        // `disputedAt + 30 d`, and not on the grace.
        const expiresAt = proposal.chainDisputedAt
          ? proposal.chainDisputedAt.getTime() + DISPUTE_TIMEOUT_MS
          : proposal.chainExecutableAt
            ? proposal.chainExecutableAt.getTime() + SLASH_EXECUTION_GRACE_MS
            : null;
        if (
          expiresAt !== null &&
          now.getTime() >= expiresAt &&
          (await this.expireAbandonedRecord(proposal))
        ) {
          expired += 1;
          continue;
        }

        waiting += 1;
      } catch (error) {
        this.logger.error(
          `slash proposal ${row.id} could not be swept while awaiting an admin cancel`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return { mirrored, expired, waiting };
  }

  /**
   * Records the provider disputed on chain (D-19) that nobody ruled on within
   * 30 days. `expireSlash` is then permissionless (`DisputeUnresolved`), so
   * this platform reaps them and the provider's reservation is released; the
   * judgement can never execute, so a case still open is closed. A record
   * whose cancel is requested is left to `sweepAdminCancels`, which applies
   * the same clock. Never throws.
   */
  async sweepUnresolvedDisputes(now: Date = new Date()): Promise<{ expired: number }> {
    if (!this.executor) return { expired: 0 };
    const rows = await this.proposals.findChainDisputedBefore(
      new Date(now.getTime() - DISPUTE_TIMEOUT_MS),
      this.config.sweepBatchSize,
    );
    let expired = 0;
    for (const row of rows) {
      try {
        const proposal = await this.proposals.findOneScoped(row.organizationId, row.id);
        if (!proposal || proposal.chainStatus !== ChainProposalStatus.DISPUTED) continue;
        if (!(await this.expireAbandonedRecord(proposal))) continue;
        expired += 1;
        await this.voidCase(
          proposal,
          { status: ChainProposalStatus.CANCELLED, lastError: null, mirroredByCaller: true },
          'the provider disputed it on chain and the arbiter did not rule within 30 days',
        );
      } catch (error) {
        this.logger.error(
          `slash proposal ${row.id}: the unresolved on-chain dispute could not be swept`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return { expired };
  }

  /**
   * `expire_slash` on a record the admin never cancelled.
   *
   * **Permissionless**, and that is the point: it needs no privilege this
   * platform would otherwise have to hold, so a provider's capital is not
   * hostage to whether anybody is at their desk. The program checks the clock
   * itself, so a call made too early is refused rather than obeyed — this
   * platform's own comparison above is a way to avoid paying for a transaction
   * that would fail, never the thing that decides.
   */
  private async expireAbandonedRecord(proposal: SlashProposalEntity): Promise<boolean> {
    if (!this.executor) return false;
    const scope = { organizationId: proposal.organizationId, id: proposal.id };

    let result: SlashCancelResult;
    try {
      result = this.parts?.appliesTo(proposal)
        ? await this.parts.expire(proposal, await this.stakeAuthorityOf(proposal))
        : await this.executor.expire({
            chainId: chainIdOf(proposal.assetId as AssetId),
            requestId: proposal.chainRequestId,
            provider: await this.stakeAuthorityOf(proposal),
          });
    } catch (error) {
      const name = chainErrorName(error);
      // `SlashNotExpired` means the chain's clock disagrees with this one —
      // ordinary around the boundary, and the next tick asks again.
      if (name !== 'SlashNotExpired') {
        this.logger.error(
          `expire_slash was refused for proposal ${proposal.id} (${name ?? 'unnamed'}); the ` +
            `reservation stands until the admin cancels or a later tick expires it`,
          error instanceof Error ? error.stack : String(error),
        );
      }
      await this.proposals
        .update(scope, { chainLastError: name ?? 'transport' })
        .catch(() => undefined);
      return false;
    }

    try {
      await this.proposals.update(scope, {
        chainStatus: ChainProposalStatus.CANCELLED,
        chainLastError: null,
      });
      await this.lifecycle.appendEventDirect({
        organizationId: proposal.organizationId,
        proposalId: proposal.id,
        occurredAt: result.cancelledAt,
        kind: 'CHAIN_CANCELLED',
        actorType: 'system',
        actorId: null,
        summary:
          result.reason === 'DISPUTE_UNRESOLVED'
            ? 'The on-chain reservation was reaped by expire_slash — the dispute went unruled ' +
              'for 30 days'
            : 'The on-chain reservation was reaped by expire_slash — nobody cancelled it inside ' +
              'the seven-day grace',
        detail: {
          signature: result.signature,
          reason: result.reason ?? 'EXPIRED',
          requestId: proposal.chainRequestId,
        },
      });
    } catch (error) {
      this.logger.error(
        `the chain reservation for proposal ${proposal.id} was expired (${result.signature}) but ` +
          `recording it failed; the row may carry a stale chain_status`,
        error instanceof Error ? error.stack : String(error),
      );
    }
    return true;
  }

  /**
   * `cancel_slash` answered `SlashNotPending`. Go and look at the record.
   *
   * There are **three** ways out of `Pending` and only two of them are the
   * outcome this method's caller wanted. The third is `Executed`, and
   * `execute_slash` is permissionless once `executable_at` passes — so on a
   * case the fleet sweep overturned days late, or one whose cancel is retried
   * after a stranger executed it, "not pending" can mean the money already
   * moved. Writing `CANCELLED` on the strength of the error name would tell the
   * provider a penalty was dropped that was in fact taken.
   *
   * This is the same rule {@link EXECUTE_MUST_READ_THE_RECORD} states for the
   * execute path, applied to the door beside it: reading is the only thing that
   * can tell the two apart.
   *
   * ## Why the execution is recorded HERE and not handed to `reconcileExecuting`
   *
   * The obvious move is to mirror `chain_status = 'EXECUTED'` with
   * `executed_at IS NULL` and let the reconcile sweep — which selects exactly
   * that pair — finish the job. It cannot, and the reason is worth writing
   * down because it looks like it works: `reconcileExecuting` completes a park
   * with `completeExecution(…, CHAIN_PROPOSABLE_STATUSES)`, and the cases that
   * reach *this* method through an overturn are `OVERTURNED`, which is not in
   * that list. The compare-and-swap would affect zero rows, `executed_at` would
   * stay null, and the row would re-match the predicate on every tick for ever:
   * one `readRecord` RPC and one `compensate` per minute, and a permanent slot
   * in every capped batch.
   *
   * Widening the list is not the fix either — it would force
   * `status = 'EXECUTED'` onto a case a human overturned, which is a chain
   * event overwriting an adjudicator. So the execution is recorded **beside**
   * the decision rather than instead of it: the money columns and the chain
   * mirror move, `status` does not, and the row never enters the park predicate
   * because `executed_at` is written in the same statement as
   * `chain_status = 'EXECUTED'`.
   *
   * The snapshot is already in hand here, so this also costs one fewer RPC than
   * the hand-off would have.
   */
  private async mirrorRecordThatLeftPending(
    proposal: SlashProposalEntity,
    reason: string,
  ): Promise<boolean> {
    if (!this.executor) return false;
    const scope = { organizationId: proposal.organizationId, id: proposal.id };

    try {
      let record: SlashRecordSnapshot | null = null;
      try {
        record = await this.readCaseRecord(proposal);
      } catch (error) {
        this.logger.error(
          `slash proposal ${proposal.id} refused cancel_slash with SlashNotPending and its ` +
            `record could not be read; the mirror still says PENDING`,
          error instanceof Error ? error.stack : String(error),
        );
      }

      if (!record) {
        // Unreachable: neither `cancel_slash` nor `expire_slash` closes the
        // account, so a record that refused the cancel is still readable. An
        // anomaly, and not one to write a status from.
        await this.proposals.update(scope, { chainLastError: 'SlashNotPending' });
        return false;
      }

      if (record.status === 'CANCELLED') {
        await this.proposals.update(scope, {
          chainStatus: ChainProposalStatus.CANCELLED,
          chainLastError: 'SlashNotPending',
        });
        return true;
      }

      if (record.status === 'EXECUTED') {
        await this.recordAnExecutionNobodyAskedFor(proposal, record, reason);
        return false;
      }

      if (record.status === 'DISPUTED') {
        // Still standing (D-19): the provider disputed it while the cancel
        // waited. `cancelSlash` still takes it; the 30-day clock is noted.
        if (record.disputedAt && !proposal.chainDisputedAt) {
          await this.proposals.update(scope, { chainDisputedAt: record.disputedAt });
        }
        return false;
      }

      // `PENDING` after `SlashNotPending` is a contradiction the chain cannot
      // produce. Change nothing on the strength of it.
      this.logger.error(
        `slash proposal ${proposal.id} refused cancel_slash with SlashNotPending but its record ` +
          `reads ${record.status}; left for a human`,
      );
      return false;
    } catch (error) {
      this.logger.error(
        `slash proposal ${proposal.id} could not be reconciled after SlashNotPending`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }

  /**
   * The chain took a penalty for a case this platform had already closed.
   *
   * A real, nameable situation rather than a fault to swallow: `execute_slash`
   * consults nobody but a fee payer, so between an adjudicator overturning a
   * case and this platform getting `cancel_slash` confirmed, any stranger may
   * spend the standing record. The money left the provider's stake and the row
   * has to say so — while still saying that a human overturned the case, which
   * is why `status` is not in the patch.
   *
   * `chk_slash_proposals_applied_within_penalty` (`applied_amount <= penalty_amount`)
   * is what splits this method in two. Every overturn path leaves
   * `penalty_amount` alone, so `applied ≤ reserved ≤ penalty_amount` and the
   * write is always legal. A **downward recalculation** is the one path that
   * can make `applied` the larger number, and there the database is right to
   * refuse: the row genuinely cannot express what happened, and both ways out
   * — writing a smaller `applied` than moved, or raising `penalty_amount` back
   * over the adjudicator's figure — destroy something true. So that case
   * records {@link EXECUTED_BEYOND_DECISION} and stops, loudly.
   *
   * **The compensation runs on all three paths, including that one.** What the
   * CHECK refuses is the *case row's* bookkeeping; the agent share is sitting in
   * the vault whatever the row can express, and a vault holding money the ledger
   * has not attributed is the reconciliation break this call exists to prevent —
   * the same reason `reconcileExecuting` runs it. Every figure comes off the
   * on-chain record rather than being recomputed, and `distribute` is idempotent
   * on the ledger's unique index, so a repeat is safe where a miss is not.
   */
  private async recordAnExecutionNobodyAskedFor(
    proposal: SlashProposalEntity,
    record: SlashRecordSnapshot,
    reason: string,
  ): Promise<void> {
    const asExecuted = {
      // Null, and it must stay null: this process never submitted anything, and
      // a fabricated signature would put a transaction in the provider's case
      // timeline that nobody can look up.
      signature: null,
      appliedMinor: record.appliedMinor,
      agentAmountMinor: record.agentAmountMinor,
      platformAmountMinor: record.platformAmountMinor,
      // `?? new Date()` is unreachable for an `Executed` record — the program
      // stamps `executed_at` in the same instruction that sets the status — and
      // is here so a decoding anomaly cannot write a null into a column
      // `chk_slash_proposals_executed_is_whole` compares against.
      executedAt: record.executedAt ?? new Date(),
    };

    if (BigInt(record.appliedMinor) > BigInt(proposal.penaltyAmount)) {
      await this.proposals.update(
        { organizationId: proposal.organizationId, id: proposal.id },
        { chainLastError: EXECUTED_BEYOND_DECISION },
      );
      this.logger.error(
        `slash proposal ${proposal.id} (${reason}): the chain took ${record.appliedMinor} but ` +
          `the case says ${proposal.penaltyAmount} was owed, so the execution CANNOT be recorded ` +
          `on the row (chk_slash_proposals_applied_within_penalty). A stranger executed the judgement ` +
          `frozen before it was recalculated. This needs a reversal (S-5) and a human.`,
      );
      // The row cannot record it; the LEDGER still must. What the CHECK refuses
      // is the case's own bookkeeping — it says nothing about the agents, and
      // the chain has already moved `record.agentAmountMinor` into the vault.
      // Returning here without this call is the one thing worse than an
      // unrecordable row: money that left the provider and was credited to
      // nobody, which is exactly the reconciliation break `compensate` exists to
      // prevent. The figures come off the on-chain record, never recomputed
      // from `penaltyAmount` — that number is precisely the one the chain
      // disagreed with. `distribute` is idempotent on the ledger's unique index,
      // so a later reversal or a repeat pass is safe.
      await this.compensate(proposal, { ...asExecuted, signature: proposal.chainRequestId });
      return;
    }

    // A case still in the proposable set is one whose normal lifecycle ENDS in
    // `EXECUTED`, so the ordinary writer is the right one: `UPHELD → EXECUTED`
    // is the transition that was going to happen anyway, not a chain event
    // overwriting a human. It also leaves the case reversible — `reverse()`
    // gates on the money columns this writes, and a reversal is exactly what a
    // penalty taken out from under a recalculation needs. (The closed branch
    // below writes the same columns, which is what made the overturned case
    // reversible too.)
    if ((CHAIN_PROPOSABLE_STATUSES as readonly string[]).includes(proposal.status)) {
      await this.completeExecution(proposal, asExecuted, CHAIN_PROPOSABLE_STATUSES);
      this.logger.error(
        `slash proposal ${proposal.id} was executed on chain by somebody else while this ` +
          `platform was trying to cancel it (${reason}); the row records the penalty the chain ` +
          `took`,
      );
      await this.compensate(proposal, { ...asExecuted, signature: proposal.chainRequestId });
      return;
    }

    // Everything below is for a case whose `status` this method must not move.
    //
    // Mostly that means CLOSED — an overturn, a platform miss, a fleet sweep —
    // and for those the row is terminal the moment this statement commits.
    //
    // Those closed rows ARE reachable by `reverse()`: it gates on `executed_at`
    // and `applied_amount`, which this statement writes, rather than on the
    // status. That is the whole point of writing them here — an overturned case
    // whose penalty a stranger took is the one case a reversal exists for.
    //
    // `EXECUTING` reaches here as well, and it is worth naming rather than
    // implying it cannot: a decide-time re-propose can race a claim
    // `executeDue` has already taken. Forcing `EXECUTED` from here would be
    // stealing a compare-and-swap that `executeOne` or `reconcileExecuting`
    // owns, so the money columns land and the case is left where it is. That
    // row DOES briefly match `findExecutingToReconcile` — its first disjunct is
    // `status = 'EXECUTING'`, which does not read `executed_at` — and it
    // terminates on the next pass, because the record reads `Executed` and
    // `completeExecution` moves it out of `EXECUTING` for one RPC. One pass,
    // not a loop.
    //
    // One statement, and `executed_at` is in it. For every CLOSED status that
    // is what keeps the row out of the park predicate's *second* disjunct
    // (`chain_status = 'EXECUTED' AND executed_at IS NULL`) — see this method's
    // caller for why being picked up there would be endless rather than help.
    await this.proposals.update(
      { organizationId: proposal.organizationId, id: proposal.id },
      {
        chainStatus: ChainProposalStatus.EXECUTED,
        chainLastError: 'SlashNotPending',
        executedAt: asExecuted.executedAt,
        executionSignature: null,
        appliedAmount: asExecuted.appliedMinor,
        platformAmount: asExecuted.platformAmountMinor,
        chainClaimedAt: null,
      },
    );

    this.logger.error(
      `slash proposal ${proposal.id} was CLOSED (${proposal.status}) and the chain executed it ` +
        `anyway, taking ${record.appliedMinor}; the row records the penalty and keeps the ` +
        `decision. Reason for the cancel attempt: ${reason}. This is a candidate for reversal.`,
    );

    try {
      await this.lifecycle.appendEventDirect({
        organizationId: proposal.organizationId,
        proposalId: proposal.id,
        occurredAt: asExecuted.executedAt,
        kind: 'EXECUTED_AFTER_CLOSURE',
        actorType: 'system',
        actorId: null,
        summary:
          `${record.appliedMinor} was taken from stake on chain after this case was already ` +
          `closed. The decision on the case stands and this is being reviewed.`,
        detail: {
          applied: record.appliedMinor,
          caseStatus: proposal.status,
          requestId: proposal.chainRequestId,
          reason,
        },
      });
    } catch (error) {
      this.logger.error(
        `slash proposal ${proposal.id} recorded a post-closure execution but its timeline entry ` +
          `failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    // The idempotency key for the ledger's unique index, which is what makes a
    // repeated distribution safe. Stable and non-null, which the absent
    // signature is neither.
    await this.compensate(proposal, { ...asExecuted, signature: proposal.chainRequestId });
  }

  /**
   * Pay the figure the adjudicator decided, not the one frozen on chain.
   *
   * `UPHELD_RECALCULATED` may lower `penalty_amount` (never raise it —
   * `recalculationExceedsOriginal` refuses that). On chain `record.penalty` was
   * frozen at proposal time and `execute_slash` takes no amount argument: it
   * applies `min(record.reserved − carried, key cap, at_risk)`, and
   * `record.reserved` is itself `min(penalty, …)` frozen three days ago.
   * Executing the standing record would therefore take **more than the
   * adjudicator decided**.
   *
   * The only correct sequence is cancel, bump the epoch, propose again. The
   * cost is that the on-chain clock restarts, so the provider waits another 72
   * hours — pure delay against a dispute that is already closed, and cheap next
   * to taking money a human ruled was not owed.
   *
   * Never throws, for the same reason {@link cancelOnChain} does not: its
   * decide-time caller has already committed.
   */
  async reproposeAtRevisedPenalty(
    organizationId: string,
    proposalId: string,
    // Defaulted rather than required: the decide-time caller is an operator
    // request with no sweep clock to hand, and `executeDue` passes its own so
    // one tick reasons about the promise from one instant.
    now: Date = new Date(),
  ): Promise<void> {
    if (!this.executor) return;

    try {
      const proposal = await this.proposals.findOneScoped(organizationId, proposalId);
      if (!proposal) return;

      // The admin has signed and the sweep has mirrored it: the old record is
      // off the chain and its stake is free, so the fresh epoch may go on. This
      // is the second half of a re-proposal, days after the first — see below.
      if (proposal.chainStatus === ChainProposalStatus.CANCELLED) {
        await this.reproposeAfterCancellation(proposal, now);
        return;
      }

      if (proposal.chainStatus !== ChainProposalStatus.PENDING) return;

      // Nothing to repair. `UPHELD_RECALCULATED` is allowed to land on the
      // figure that was already there, or on one the reservation already
      // bounds, and cancelling then would cost the provider another 72 hours
      // for an identical judgement. The predicate is shared with `executeDue`
      // on purpose — see its header for why they must not disagree.
      if (!this.theStandingRecordMayTakeMoreThanWasDecided(proposal)) {
        this.logger.log(
          `slash proposal ${proposalId} was recalculated to ${proposal.penaltyAmount}, which the ` +
            `standing record's reservation of ${proposal.chainReserved} already bounds; keeping ` +
            `it and its clock`,
        );
        return;
      }

      // Ask, and stop. The epoch is **not** bumped here: a fresh request id
      // while the old record is still `Pending` would reserve the stake TWICE —
      // the provider held for both figures at once — and `propose_slash`'s
      // `init` cannot refuse it, because the second id is genuinely unused.
      //
      // The admin-only cancel is what makes this two calls instead of one.
      // `cancel_slash` is the admin's, so the release happens whenever a human
      // signs the transaction `POST /operator/cases/:id/cancel-intent` builds
      // (or seven days later, when `sweepAdminCancels` expires the record).
      // Either way that sweep mirrors `CANCELLED`, and the branch at the top of
      // this method finishes the re-proposal on a later tick.
      await this.requestAdminCancel(organizationId, proposalId, 'the penalty was recalculated');
      this.logger.log(
        `slash proposal ${proposalId} was recalculated below its standing reservation; the ` +
          `record is awaiting the settlement admin's cancel_slash and will be re-proposed at ` +
          `the decided figure once it is off the chain`,
      );
      return;
    } catch (error) {
      this.logger.error(
        `slash proposal ${proposalId} could not be re-proposed at its revised penalty`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * The second half of {@link reproposeAtRevisedPenalty}: the old record is
   * confirmed off the chain, so bump the epoch and propose the decided figure.
   *
   * Split out rather than inlined because the two halves are separated by a
   * human signing a transaction — days, in the worst case — and nothing may
   * reach this one without the mirror actually saying `CANCELLED`.
   */
  private async reproposeAfterCancellation(
    proposal: SlashProposalEntity,
    now: Date,
  ): Promise<void> {
    const organizationId = proposal.organizationId;
    const proposalId = proposal.id;
    try {
      const chainEpoch = proposal.chainEpoch + 1;
      // Derived from the BUMPED epoch. Deriving from the row as it stands would
      // reproduce the id that was just cancelled, and `propose_slash`'s `init`
      // would refuse it forever.
      const chainRequestId = deriveChainRequestId({ id: proposal.id, chainEpoch });

      // One statement. `chk_slash_proposals_chain_pending_is_whole` refuses a
      // `PENDING`/`EXECUTED` mirror without both chain clocks, so nulling the
      // clocks and returning the status to `NONE` separately would be rejected
      // by the database rather than merely be untidy.
      //
      // `NONE` is also the recovery: if the propose below throws, the row is
      // exactly what `findAwaitingChainProposal` selects, and the next sweep
      // re-proposes it under this same fresh id.
      await this.proposals.update(
        { organizationId, id: proposalId },
        {
          chainEpoch,
          chainRequestId,
          chainStatus: ChainProposalStatus.NONE,
          chainProposedAt: null,
          chainExecutableAt: null,
          chainReserved: null,
          chainProposalSignature: null,
          // The previous epoch's claim. Left standing it would misdate work
          // that belongs to a request id that no longer exists.
          chainClaimedAt: null,
          chainLastError: null,
        },
      );

      // Re-read: `update()` does not refresh the entity it was handed, and
      // `proposeOne` signs for whatever `chainRequestId` the row carries.
      const refreshed = await this.proposals.findOneScoped(organizationId, proposalId);
      if (!refreshed) return;

      // Same rule as the sweep, and the row is already in the state that makes
      // deferring safe: the update above set `chain_status = 'NONE'` with both
      // clocks nulled, which is exactly what `findAwaitingChainProposal`
      // selects. So returning here is not a strand — the sweep re-proposes this
      // fresh epoch the first tick on which the door can land after the promise.
      // The old, larger record has already been cancelled, so nothing is
      // reserved in the meantime.
      if (
        this.proposingNowWouldOutrunThePromise(
          refreshed,
          now,
          await this.slashDelayMs(refreshed, new Map()),
        )
      ) {
        this.logger.log(
          `slash proposal ${proposalId} was re-proposed at its revised penalty but its promise ` +
            `runs to ${refreshed.earliestExecutionAt.toISOString()}; the fresh epoch is left for ` +
            `the sweep to propose once a record written then cannot outrun it`,
        );
        return;
      }

      const mirrored = await this.proposeOne(refreshed);
      if (mirrored !== ChainProposalStatus.PENDING) {
        // The fresh epoch's request id was ALSO taken. Silently ignoring that
        // would leave the case believing it has a live proposal when what sits
        // at its PDA is a record that can never be executed.
        this.logger.error(
          `slash proposal ${proposalId} was re-proposed at its revised penalty under epoch ` +
            `${chainEpoch} and found that id already spent (${mirrored}); no live proposal ` +
            `stands for this case`,
        );
      }
    } catch (error) {
      this.logger.error(
        `re-proposing slash proposal ${proposalId} at its revised penalty failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Could the standing record still take more than the adjudicator decided?
   *
   * The invariant, from the program source rather than from inference:
   * `execute_slash.rs:45` — `applied = min(record.reserved − window_carried,
   * key_cap_remaining, at_risk)`, and `propose_slash.rs:223` —
   * `reserved = min(penalty, cap_allowance, free)`, frozen at proposal. So
   * `applied ≤ chain_reserved` **always**, and the chain can overtake the
   * decision on exactly one condition: the row's penalty has since been lowered
   * BELOW what was reserved. `UPHELD_RECALCULATED` is the only thing that
   * lowers it.
   *
   * ## One predicate, deliberately, for two callers
   *
   * {@link executeDue} asks it before executing and
   * {@link reproposeAtRevisedPenalty} asks it before spending another 72 hours.
   * They **must** agree: two predicates that disagreed would make one defer
   * every tick while the other declined to act, which is a silent infinite
   * loop rather than a bug anybody would see.
   *
   * It also makes a recalculation that changed nothing free. An
   * `UPHELD_RECALCULATED` landing on the same figure leaves
   * `penalty ≥ reserved`, so nothing is cancelled and the provider keeps the
   * clock they already have instead of waiting another three days for an
   * identical judgement.
   *
   * ## Why an unknown reservation answers `false`
   *
   * `proposeOne` writes `chain_reserved` in the same statement as
   * `chain_status = 'PENDING'`, and the two other writers of that mirror
   * (`mirrorRecordThatLeftPending`, `reproposeAtRevisedPenalty`) never leave
   * `PENDING` behind with the column null. So a null here is not a state this
   * system can reach, and the answer only decides which impossible thing is
   * cheaper to be wrong about.
   *
   * `false` — execute — is the cheaper one, and this is a deliberate reversal
   * of the first attempt. Answering `true` would cancel and re-propose a
   * perfectly healthy judgement on the strength of a **missing column**, which
   * costs the provider another 72 hours for nothing and is the only way this
   * guard could ever harm the party it exists to protect. Answering `false`
   * does what the code did before the guard existed, and the overpayment it
   * would have to permit needs a recalculation — which reaches the chain only
   * through paths that write the column.
   */
  private theStandingRecordMayTakeMoreThanWasDecided(proposal: SlashProposalEntity): boolean {
    if (!proposal.chainReserved) return false;
    return BigInt(proposal.penaltyAmount) < BigInt(proposal.chainReserved);
  }

  /**
   * The base58 stake authority of a provider — the account `slash` takes from.
   *
   * `providerId` is the organization uuid (`providerId == organizationId` is
   * load-bearing across this codebase) and the executor port wants the address
   * the provider proved control of at registration. The two were being conflated:
   * `address()` rejects a uuid, so every execution threw before building a
   * transaction, which is why no slash had ever reached the chain from this
   * path.
   *
   * Throws rather than defaulting. A provider with no proved stake authority
   * has no stake account to take from, and inventing an address here would
   * either fail on chain or — worse — name somebody else's.
   */
  private async stakeAuthorityOf(proposal: SlashProposalEntity): Promise<string> {
    const account = await this.stakeAuthorityAccountOf(proposal);
    // Stored CAIP-10 (`chk_provider_chain_enrolments_stake_caip10` enforces
    // it); the port takes the bare address.
    return parseAccountId(account).address;
  }

  /**
   * The same authority as {@link stakeAuthorityOf}, still in CAIP-10.
   *
   * `StakeIntentBuilderPort` is keyed by account rather than by address — it
   * needs the chain to derive an asset and a scale — so the two compensation
   * routes take this one and the chain-facing executor takes the bare address.
   */
  private async stakeAuthorityAccountOf(proposal: SlashProposalEntity): Promise<AccountId> {
    // The chain comes off the PROPOSAL's own `asset_id`, a persisted CAIP-19
    // column, and not from a binding — so this is NOT one of the seven
    // settlement-chain derivation expressions `tool/domain/routing/eligibility.ts`
    // enumerates, and that enumeration records the exclusion as well, because
    // an audit of those expressions reads the list rather than this file.
    // `scripts/devnet/acceptance-suite.ts` makes the same read for the same
    // reason and is excluded there alongside this one. A penalty is
    // denominated in the asset it was taken in, and the collateral it reaches
    // into is the collateral on that asset's chain: a slash is executed by one
    // chain's settlement contract, which can neither see nor take an account on
    // another.
    const chainId = chainIdOf(proposal.assetId as AssetId);

    const enrolment = await this.enrolments.findOneBy({
      organizationId: proposal.providerId,
      chainId,
    });

    if (!enrolment?.stakeAuthorityAccountId) {
      throw ProviderErrors.stakeAuthorityUnprovenFor({ providerId: proposal.providerId, chainId });
    }

    return enrolment.stakeAuthorityAccountId as AccountId;
  }

  /**
   * The account this penalty's compensating share is paid into, persisted so
   * the row records what was signed.
   *
   * Returns `null` rather than throwing when no resolver is wired, so the
   * caller's existing `SLASH_NO_BENEFICIARY` refusal stays the single place
   * that decides what a missing beneficiary means.
   */
  private async resolveBeneficiary(proposal: SlashProposalEntity): Promise<string | null> {
    if (!this.beneficiaries) return null;

    const account = await this.beneficiaries.resolve(proposal.assetId as AssetId);

    await this.proposals.update(
      { organizationId: proposal.organizationId, id: proposal.id },
      { beneficiaryAccount: account },
    );

    return account;
  }

  /**
   * One case, from `UPHELD` to `EXECUTED`.
   *
   * `EXECUTING` exists for a single reason: the interval between submitting a
   * transaction and learning whether it landed. Without it a process that died
   * mid-submit would leave the case `UPHELD`, the next tick would submit again,
   * and the platform would have no record that it had ever tried. `EXECUTING`
   * makes an interrupted attempt visible — and with the two-phase lifecycle it
   * is more than bookkeeping, because the `request_id` lock is spent at
   * *proposal* time and a blind re-submission can no longer tell "it failed"
   * from "it worked and I did not hear".
   *
   * ## What happens before the claim, and why
   *
   * Everything that can fail without touching the chain — the beneficiary, the
   * provider's stake authority — is resolved **before** `UPHELD → EXECUTING`.
   * Past the claim the only failures possible are the chain call itself and the
   * writes that record it, which are exactly the failures the reconciler can
   * resolve by reading the record. A local refusal after the claim would strand
   * the row in `EXECUTING` for a reconciler that needs the very thing that
   * refused (`stakeAuthorityOf` is also how the record is read).
   *
   * Returns `false` when the compare-and-swap was lost — another replica is
   * executing this case, which is not an error and must not be counted as one.
   */
  private async executeOne(proposal: SlashProposalEntity, now: Date): Promise<boolean> {
    if (!this.executor) {
      throw SlashErrors.notExecuted({ status: 'no slash executor is configured' });
    }

    // Stamped by `proposeOne` before it signed, because `beneficiary` is a
    // field of the signed attestation. It is read here and never
    // re-resolved: the on-chain record names the account the proposal named,
    // and executing on one chosen now would either be refused by the program or
    // — worse — pay an account the judgement never authorised. Reaching here
    // without one means the row was written by a path that skipped `proposeOne`.
    const beneficiaryAccount = proposal.beneficiaryAccount;
    if (!beneficiaryAccount) {
      throw SlashErrors.noBeneficiary();
    }

    // The provider's **stake authority**, not their id. `providerId` is the
    // organization uuid and the port hands `provider` straight to `address()`,
    // which throws on a uuid — that is why nothing had ever executed a slash.
    const provider = await this.stakeAuthorityOf(proposal);

    // The claim, and the only thing that stops two scheduler replicas both
    // submitting `execute_slash` for one case. A real compare-and-swap: the
    // target `EXECUTING` is not in its own expected set, so the second worker
    // re-evaluates against the committed row and loses.
    //
    // `chain_claimed_at` moves in the same statement because it is what
    // `findExecutingToReconcile` measures staleness against — a claim the
    // reconciler cannot age is a claim it can only find by its defensive
    // `IS NULL` half.
    const claimed = await this.proposals.transitionIfIn(
      proposal.organizationId,
      proposal.id,
      [SlashProposalStatus.UPHELD],
      { status: SlashProposalStatus.EXECUTING, chainClaimedAt: now },
    );
    if (claimed === 0) return false;

    // Phase two of the on-chain lifecycle, and **only** phase two.
    //
    // Slashing is `propose_slash` → 72h → `execute_slash`, not one call. The
    // penalty, the policy and the response class are all fields of the
    // *proposal*, signed by a verifier three days earlier, so they are gone
    // from this call: `execute_slash` reads every one of them off the
    // `SlashRecord` and consults the submitter about nothing but the fee.
    const result = await this.executor.executeProposal({
      chainId: chainIdOf(proposal.assetId as AssetId),
      requestId: proposal.chainRequestId,
      provider,
      // The column is CAIP-10; the port takes a bare base58 address and calls
      // `address()` on it, which throws on the prefixed form. This boundary is
      // the only place the two spellings meet.
      beneficiary: bareAddress(beneficiaryAccount),
    });

    // The affected count is deliberately not consulted. `completeExecution`
    // logs and skips its announcements when it loses the CAS; what follows is
    // owed on the chain's fact, not on whether this row won a race — see the
    // counting rule in `executeDue`'s header.
    await this.completeExecution(proposal, result, [SlashProposalStatus.EXECUTING]);

    // Last, and deliberately after the case is already `EXECUTED`. The
    // penalty has been taken on chain and the vault already holds the agent
    // share; distributing it is a second, resumable step. A failure here must
    // not reopen a case the chain has settled — it must be loud and retried,
    // which the unique index on the ledger entries makes safe.
    await this.compensate(proposal, result);
    return true;
  }

  /**
   * The `→ EXECUTED` write, shared by the live path and the reconciler, so a
   * recovered row and a freshly executed one record the same thing.
   *
   * Every number comes off the chain: `applied` is what was actually taken (the
   * 10%/24h cap and a provider holding less than the judgement both reduce it,
   * and the shortfall is discharged rather than carried), and `platform_amount`
   * is the treasury's share at the rate frozen on the provider's own
   * `ProviderTerms`. Neither is recomputed here.
   *
   * ## The columns that have to move together
   *
   * One statement, because three CHECK constraints bind them:
   * `chk_slash_proposals_executed_is_whole` refuses an `executed_at` without an
   * `applied_amount`; `…_execution_respects_timelock` and
   * `…_execution_respects_chain_timelock` compare `executed_at` against both
   * clocks.
   *
   * Two of the three hold by construction here: the amounts and the timestamp
   * come off the same record, and the program cannot stamp an `executed_at`
   * before its own `executable_at`.
   *
   * `…_execution_respects_timelock` (`executed_at >= earliest_execution_at`) is
   * **not** one of them, and the difference matters. It holds on every path that
   * proposes and executes normally — `earliest_execution_at` is written once when
   * the case is opened, and the chain's own clock is the later of the two. But
   * `earliest_execution_at` is not immutable: `ArbitrationService.extendDeadline`
   * (`S-8`) moves it forward. An extension that outruns the chain's frozen
   * `executable_at` is now REFUSED while a live record stands — which is what
   * keeps a stranger from executing inside a window the provider was promised —
   * but a case extended before its record was proposed can still carry a promise
   * later than the execution. Then this write is the thing that fails: the
   * constraint RAISES for an execution that really happened, so it does not
   * arrive as `affected === 0` below but as a throw into the caller's catch,
   * and the money has moved with nothing on the row to say so. That is a human's
   * problem, not a branch here — the alternatives are falsifying `executed_at`
   * or moving a deadline a provider was told.
   *
   * `chain_status` and the case `status` move together too, which is what makes
   * `chain_status = 'EXECUTED' AND executed_at IS NULL` — the reconciler's
   * park predicate — a pair only `proposeOne` can produce.
   *
   * @param expectedFrom the statuses this may move from. `[EXECUTING]` on the
   *   live and crash-recovery paths; the proposable set for the adopted park,
   *   whose case never entered the execution states at all.
   * @returns the rows affected. Zero means somebody else moved the case first,
   *   and nothing is announced for a transition that did not happen.
   */
  private async completeExecution(
    proposal: SlashProposalEntity,
    result: {
      readonly signature: string | null;
      readonly appliedMinor: string;
      readonly platformAmountMinor: string;
      readonly executedAt: Date;
    },
    expectedFrom: readonly string[],
  ): Promise<number> {
    const affected = await this.proposals.transitionIfIn(
      proposal.organizationId,
      proposal.id,
      expectedFrom,
      {
        status: SlashProposalStatus.EXECUTED,
        executedAt: result.executedAt,
        executionSignature: result.signature,
        appliedAmount: result.appliedMinor,
        // Recorded, never booked: it went to the treasury, which is outside the
        // vault the reconciler measures.
        platformAmount: result.platformAmountMinor,
        chainStatus: ChainProposalStatus.EXECUTED,
        // Nothing is in flight for this row any more. Leaving the claim
        // standing would keep it inside `findExecutingToReconcile`'s staleness
        // window for no reason.
        chainClaimedAt: null,
        chainLastError: null,
      },
    );

    if (affected === 0) {
      this.logger.error(
        `slash proposal ${proposal.id} took ${result.appliedMinor} on chain but the row had ` +
          `already left ${expectedFrom.join('/')}; the execution is NOT recorded on it`,
      );
      return 0;
    }

    // Past this line the case is `EXECUTED` and nothing may throw. An exception
    // here would reach `executeDue`'s catch, which would stamp
    // `chain_last_error` — and, for a failure the program never named, leave a
    // settled case sitting in `EXECUTING` for the reconciler to re-read. Both
    // are worse than a lost annotation, and both are recoverable by a human
    // reading the line below.
    try {
      await this.lifecycle.appendEventDirect({
        organizationId: proposal.organizationId,
        proposalId: proposal.id,
        occurredAt: result.executedAt,
        kind: 'EXECUTED',
        actorType: 'system',
        actorId: null,
        summary: `Penalty of ${result.appliedMinor} taken from stake`,
        detail: {
          signature: result.signature,
          requested: proposal.penaltyAmount,
          applied: result.appliedMinor,
        },
      });

      await this.notifications.notify({
        organizationId: proposal.organizationId,
        event: NotificationEvent.PROVIDER_SLASH_EXECUTED,
        title: `${result.appliedMinor} was taken from your stake`,
        body:
          `The proposal was upheld and the timelock has elapsed. ` +
          // No signature on the recovery path, and no sentence pretending
          // otherwise: a transaction id nobody can look up is worse than none.
          (result.signature ? `Transaction ${result.signature}.` : `The case page has the detail.`),
        subjectType: SLASH_PROPOSAL_SUBJECT_TYPE,
        subjectId: proposal.id,
        dedupeKey: `${proposal.id}:executed`,
        payload: {
          proposalId: proposal.id,
          applied: result.appliedMinor,
          requested: proposal.penaltyAmount,
          signature: result.signature,
        },
      });
    } catch (error) {
      this.logger.error(
        `slash proposal ${proposal.id} is recorded EXECUTED but announcing it failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return affected;
  }

  /**
   * Credit the harmed agents from the share now sitting in the vault.
   *
   * Never throws, for the reason above. `null` when no distributor is wired —
   * every process except the scheduler — which is the same shape the executor
   * itself uses.
   */
  private async compensate(
    proposal: SlashProposalEntity,
    result: SlashExecutionResult,
  ): Promise<void> {
    if (!this.compensation) return;

    // Paid on chain, straight to each harmed agent's own account, by the
    // contract. Booking a ledger credit too would pay them twice, out of a
    // vault that never received the money.
    if (this.parts?.appliesTo(proposal)) {
      this.logger.log(
        `slash case ${proposal.id}: ${result.agentAmountMinor} paid on chain to the harmed ` +
          `agents directly; nothing is booked to the ledger`,
      );
      return;
    }

    try {
      const credited = await this.compensation.distribute({
        windowId: proposal.windowId,
        agentAmountMinor: result.agentAmountMinor,
        assetId: proposal.assetId,
        decimals: proposal.decimals,
        signature: result.signature,
        providerId: proposal.providerId,
      });
      if (credited > 0) {
        this.logger.log(
          `slash ${result.signature}: ${result.agentAmountMinor} distributed to ${credited} agent(s)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `slash ${result.signature} executed but compensation failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * `S-5`, step one — the unsigned `deposit_stake` that compensates a provider
   * whose executed judgement was overturned.
   *
   * ## Why a deposit and not a reversal
   *
   * There is no `reverse_slash` in the settlement program. Undoing an executed
   * slash on chain needed an instruction that could move money *back into* a
   * provider's stake on a verifier's say-so, and every door of that shape is a
   * door somebody can push the other way. What replaced it is the plainest
   * possible thing: the treasury deposits into the provider's stake with
   * `deposit_stake`, the same instruction any provider uses to fund their own.
   * A deposit can only ever increase what the provider owns, which is why the
   * program lets a funder who is not the provider sign one at all.
   *
   * ## Who signs it, and why not this process
   *
   * The treasury is a multisig. This builds the transaction with an empty
   * signature slot addressed to it and hands it back; the treasury's signers
   * sign it, and the case is not touched until {@link markCompensated} is shown
   * the confirmed signature. A backend that could sign a treasury spend would
   * be a backend that could drain the treasury.
   *
   * The amount is `applied_amount` — what the chain actually took — read off
   * the row rather than recomputed. It is the gross penalty, so it is more than
   * the `agent_amount + platform_amount` a `reverse_slash` used to restore; the
   * difference is the provider's own share, which the program never took out of
   * `bonded` in the first place. Compensating the gross figure therefore leaves
   * the provider very slightly ahead, and that is the deliberate choice: it is a
   * platform mistake being made good, the discrepancy is bounded by the split,
   * and erring the other way would leave a wronged provider short.
   */
  async compensationIntent(
    organizationId: string,
    proposalId: string,
  ): Promise<SlashCompensationIntent> {
    if (!this.stakeIntents || !this.executor) {
      throw SlashErrors.chainUnavailable({
        proposalId,
        reason: 'no settlement executor or stake intent builder',
      });
    }

    const proposal = await this.lifecycle.require(organizationId, proposalId);
    this.assertCompensable(proposal);

    const account = await this.stakeAuthorityAccountOf(proposal);
    const treasury = await this.executor.settlementTreasury(proposal.assetId as AssetId);
    const amount = MoneyUtil.of(
      BigInt(proposal.appliedAmount as string),
      proposal.assetId as AssetId,
      proposal.decimals,
    );

    const { transaction } = await this.stakeIntents.buildIntent({
      kind: StakeIntentKind.DEPOSIT,
      account,
      amount,
      funder: treasury,
    });

    // `buildIntent` returns the discriminated transaction union, and
    // `SlashCompensationIntent` carries Solana wire bytes. Narrowing rather
    // than casting is the point: on an `eip155` member there ARE no wire bytes
    // to hand a Squads multisig — that path is an EIP-712 signature request the
    // relayer submits — so the honest answer is the catalogued refusal, not
    // `undefined` serialised into a field a human is about to sign against.
    if (!isSolanaTransaction(transaction)) {
      throw SlashErrors.chainUnavailable({
        proposalId,
        reason: `compensation intent is ${transaction.namespace}/${transaction.kind}, not solana wire bytes`,
      });
    }

    return {
      transaction: transaction.transactionBase64,
      provider: parseAccountId(account).address,
      amountMinor: proposal.appliedAmount as string,
      depositor: parseAccountId(treasury).address,
    };
  }

  /**
   * `S-5`, step two — record a compensation the treasury has already paid.
   *
   * The signature is **verified against the cluster**, not trusted: the
   * transaction has to have confirmed, and to contain a `deposit_stake` into
   * this provider's own stake account for at least the amount the chain took,
   * funded by the settlement treasury and mined after the slash executed
   * (review M-3: before, the provider's own earlier deposit passed). One
   * deposit compensates one case (`uq_slash_proposals_reversal_signature`), and
   * the status moves inside the override's transaction.
   * Without that check this route would be a way to mark a case compensated by
   * typing a plausible string, which is the same thing as not having the route.
   *
   * The chain read happens **before** the local compare-and-swap, for the
   * reason the old reversal path gave: a local write must never claim a
   * restoration the chain cannot show. A crash between the two leaves the row
   * uncompensated and the money paid, and the operator retries with the same
   * signature — recoverable, and diagnosable.
   *
   * Three guards, and the redundancy is the point:
   *
   * 1. `markReversedIfExecuted`'s `reversed_at IS NULL` predicate, which makes
   *    two concurrent requests produce one winner.
   * 2. `chk_slash_proposals_reversal_needs_execution`, which survives a second
   *    write path somebody adds later.
   * 3. The cluster itself, which is the only one authoritative about money.
   *
   * The columns and the `REVERSED` status keep their names. What changed is
   * where the money comes from, not what the case is claiming.
   */
  async markCompensated(
    operator: OperatorSession,
    approver: OperatorSession,
    organizationId: string,
    proposalId: string,
    signature: string,
    reasonCode: string,
    note: string,
    requestId?: string | null,
  ): Promise<SlashProposalEntity> {
    if (!this.stakeIntents || !this.executor) {
      throw SlashErrors.chainUnavailable({
        proposalId,
        reason: 'no settlement executor or stake intent builder',
      });
    }

    const proposal = await this.lifecycle.require(organizationId, proposalId);
    this.assertCompensable(proposal);

    const from = proposal.status as SlashProposalStatus;
    if (!canTransition(from, SlashProposalStatus.REVERSED)) {
      throw SlashErrors.invalidTransition({ from, to: SlashProposalStatus.REVERSED });
    }

    // An EVM hash is hex, and `0xAB…` and `0xab…` are one transaction; stored
    // lower-case so the unique index sees them as one. Solana signatures are
    // base58 and case-sensitive, so they are kept as given.
    if (namespaceOf(proposal.assetId as AssetId) === ChainNamespace.EIP155) {
      signature = signature.toLowerCase();
    }

    const account = await this.stakeAuthorityAccountOf(proposal);
    // Review M-3: only a deposit the treasury funded, mined after this slash
    // executed. `assertCompensable` has already required `executed_at`.
    const treasury = await this.executor.settlementTreasury(proposal.assetId as AssetId);
    const deposited = await this.stakeIntents.confirmedDeposit(signature, account, {
      funder: treasury,
      after: proposal.executedAt as Date,
    });
    const owed = BigInt(proposal.appliedAmount as string);
    if (deposited === null || MoneyUtil.toAtomic(deposited) < owed) {
      throw SlashErrors.compensationNotConfirmed({
        signature,
        owed: proposal.appliedAmount,
        deposited: deposited ? MoneyUtil.toAtomic(deposited).toString() : null,
      });
    }

    const restoredMinor = MoneyUtil.toAtomic(deposited).toString();
    const compensatedAt = new Date();

    return this.overrides
      .perform<SlashProposalEntity>(
        {
          code: 'S-5',
          actor: operator,
          approver,
          targetType: 'slash_proposal',
          targetId: proposalId,
          organizationId,
          reasonCode,
          reason: note,
          requestId: requestId ?? null,
          // What actually moved, decoded from the transaction — never what the
          // row said was owed. An operator's authority limit has to be checked
          // against the money the treasury really paid.
          amountMinor: restoredMinor,
        },
        async (queryRunner) => {
          let affected: number;
          try {
            affected = await this.proposals.markReversedIfExecuted(
              organizationId,
              proposalId,
              compensatedAt,
              signature,
              queryRunner.manager,
            );
          } catch (error) {
            if (isUniqueViolation(error, 'uq_slash_proposals_reversal_signature')) {
              throw SlashErrors.compensationAlreadyUsed({ signature });
            }
            throw error;
          }
          if (affected === 0) {
            // The deposit landed and the local guard refused it, which means
            // somebody else recorded it in the interval. Not an error to the
            // operator, but it must not write a second register entry claiming
            // they did it.
            throw SlashErrors.alreadyReversed({ reversedAt: compensatedAt.toISOString() });
          }

          await this.lifecycle.appendEvent(queryRunner, {
            organizationId,
            proposalId,
            occurredAt: compensatedAt,
            kind: 'REVERSED',
            actorType: 'operator',
            actorId: operator.subject,
            summary: `${restoredMinor} deposited back into stake by the treasury`,
            // `from` is on the timeline for the same reason it is on the
            // override register: `OVERTURNED` here means the chain took the
            // penalty after the case was closed, which is a different story
            // from a review that changed its mind.
            detail: { signature, restored: restoredMinor, from },
          });

          const value = await queryRunner.manager.findOneOrFail(SlashProposalEntity, {
            where: { organizationId, id: proposalId },
          });
          return {
            value,
            // The status the row was really in, not a constant. A case the
            // chain executed after an overturn is compensated from
            // `OVERTURNED`, and a register that recorded `EXECUTED` for it
            // would say this platform had executed a judgement its own
            // adjudicator dropped.
            before: { status: from, reversedAt: null },
            after: {
              status: SlashProposalStatus.REVERSED,
              reversedAt: compensatedAt.toISOString(),
              restored: restoredMinor,
            },
          };
        },
      )
      .then(async (saved) => {
        await this.notifications.notify({
          organizationId,
          event: NotificationEvent.PROVIDER_SLASH_REVERSED,
          title: `${restoredMinor} was returned to your stake`,
          // Two different things happened, and one sentence cannot describe
          // both honestly. A case compensated out of `EXECUTED` was reviewed
          // and the review changed the answer. One compensated out of
          // `OVERTURNED` was already decided in the provider's favour and the
          // penalty was taken anyway — telling them it "was reversed on review"
          // would describe a review that had already happened and hide the fact
          // that we took their money after it.
          body:
            (from === SlashProposalStatus.OVERTURNED
              ? `This case had already been overturned and the penalty was taken on chain ` +
                `anyway. It has been returned. `
              : `The penalty was reversed on review. `) +
            `Transaction ${signature}. ` +
            `The case page lists everything that was restored.`,
          subjectType: 'slash_proposal',
          subjectId: proposalId,
          dedupeKey: `${proposalId}:reversed`,
          payload: { proposalId, restored: restoredMinor, signature },
        });
        return saved;
      });
  }

  /**
   * The one predicate both compensation routes share.
   *
   * **"Money left the provider", not "the case ended a particular way".**
   * `execute_slash` is permissionless once `executable_at` passes, so a stranger
   * may spend a standing record after an adjudicator has overturned the case;
   * {@link recordAnExecutionNobodyAskedFor} records that honestly — the money
   * columns land and `status` stays `OVERTURNED`, because a chain event must
   * not overwrite a human. Every *other* overturn needs no compensation,
   * because nothing was taken.
   */
  private assertCompensable(proposal: SlashProposalEntity): void {
    if (proposal.reversedAt) {
      throw SlashErrors.alreadyReversed({ reversedAt: proposal.reversedAt.toISOString() });
    }
    if (!proposal.executedAt || proposal.appliedAmount === null) {
      throw SlashErrors.notExecuted({ status: proposal.status });
    }
  }

  /**
   * `S-11` — carry one conclusion to every binding the same defect touched.
   *
   * On by default, *"even for providers who never disputed"*, for one reason:
   * **a platform defect is never a single-provider event.** If our mapping dropped
   * a field, every binding on that tool failed the same way, and only the
   * provider who complained gets relief. That is the difference between an
   * honest system and one that refunds only the noisy.
   *
   * Matching is by `rootCauseKey` over a window, not by resemblance to the
   * source case, so the set is reproducible: anyone can re-run the predicate
   * later and get the same list, which turns "we swept it" into a checkable
   * claim rather than an assurance.
   */
  async openSweep(
    operator: OperatorSession,
    approver: OperatorSession,
    organizationId: string,
    sourceProposalId: string,
    input: { defectKey: string; lookbackHours: number; reasonCode: string; note: string },
    requestId?: string | null,
  ): Promise<FleetSweepEntity> {
    const source = await this.lifecycle.require(organizationId, sourceProposalId);
    const outcome = source.outcome as ArbitrationOutcome | null;

    // Two different refusals. No bound outcome is a wrong-status answer — the
    // case is undecided, or was closed without an adjudicator — and an outcome
    // that does not generalise is a statement about that outcome.
    if (!outcome) {
      throw SlashErrors.actionNotAllowedInStatus({
        action: 'open a fleet sweep',
        status: source.status,
        allowed: 'decided as a platform or policy defect',
      });
    }
    if (!OUTCOME_CONSEQUENCE[outcome].opensFleetSweep) {
      throw SlashErrors.outcomeNotSweepable({ outcome });
    }

    // Review M-2: the sweep matches on `root_cause_key`, so it may only carry
    // the source case's own root cause, never a free-text key.
    if (!source.rootCauseKey || input.defectKey !== source.rootCauseKey) {
      throw SlashErrors.sweepDefectKeyMismatch({
        defectKey: input.defectKey,
        rootCauseKey: source.rootCauseKey,
      });
    }

    const to = new Date();
    const from = new Date(to.getTime() - input.lookbackHours * 60 * 60 * 1000);

    // Matched before the override, so the authority check sees the money the
    // sweep can drop: the summed penalties of every matched case.
    const matched = (
      await this.proposals.findSweepCandidates(
        input.defectKey,
        from,
        to,
        this.config.sweepBatchSize,
      )
    ).filter((candidate) => candidate.id !== sourceProposalId);
    const matchedMinor = matched
      .reduce((sum, candidate) => sum + BigInt(candidate.penaltyAmount), 0n)
      .toString();

    const { sweep, applied } = await this.overrides.perform<{
      sweep: FleetSweepEntity;
      applied: QueuedProposalRow[];
    }>(
      {
        code: 'S-11',
        actor: operator,
        approver,
        targetType: 'slash_proposal',
        targetId: sourceProposalId,
        // Platform-wide: a sweep has no single subject tenant, which is exactly
        // the case the nullable column exists for.
        organizationId: null,
        reasonCode: input.reasonCode,
        reason: input.note,
        requestId: requestId ?? null,
        amountMinor: matchedMinor,
      },
      async (queryRunner) => {
        const saved = await queryRunner.manager.save(
          FleetSweepEntity,
          queryRunner.manager.create(FleetSweepEntity, {
            openedByOperatorId: operator.operatorId,
            sourceProposalId,
            outcome,
            defectKey: input.defectKey,
            windowFrom: from,
            windowTo: to,
            status: 'OPEN',
          }),
        );
        // Every case in this one transaction, with the register entry: the
        // sweep lands whole or not at all (review M-2). Before, each case was
        // its own write after the entry had committed, and one refused row
        // left the earlier cases overturned and the sweep OPEN.
        const swept = await this.applySweep(queryRunner, saved, operator, matched);
        const completion = {
          status: 'COMPLETED',
          matchedCount: matched.length,
          appliedCount: swept.length,
          completedAt: new Date(),
        };
        await queryRunner.manager.update(FleetSweepEntity, { id: saved.id }, completion);
        // The row as stored, not as first saved: the route answers with it, and
        // the first save is `OPEN` with no counts (BUG-R11-O1-02).
        const completed = Object.assign(saved, completion);

        return {
          value: { sweep: completed, applied: swept },
          before: {
            sweep: null,
            cases: matched.map((candidate) => ({ id: candidate.id, status: candidate.status })),
          },
          after: {
            sweepId: saved.id,
            outcome,
            defectKey: input.defectKey,
            windowFrom: from.toISOString(),
            windowTo: to.toISOString(),
            matchedPenaltyMinor: matchedMinor,
            appliedProposalIds: swept.map((candidate) => candidate.id),
          },
        };
      },
    );

    this.logger.log(
      `fleet sweep ${sweep.id} matched ${matched.length} case(s), applied to ${applied.length}`,
    );
    // After the commit: telling the provider and asking for the on-chain
    // cancel. Neither may undo the sweep. A lost cancel request is repaired by
    // the lifecycle job's pass over closed cases.
    for (const candidate of applied) {
      await this.afterSweepApplied(sweep, candidate);
    }
    return sweep;
  }

  /**
   * Overturn each matched case still in a sweepable status, inside the
   * override's transaction. The sweep's actor is recorded as the case's
   * decider (the sweep resolved it, not the adjudicator who decided it before),
   * and an earlier second signature is cleared: it countersigned a decision
   * that no longer stands, and the sweep's own approver is on the register.
   */
  private async applySweep(
    queryRunner: QueryRunner,
    sweep: FleetSweepEntity,
    operator: OperatorSession,
    candidates: readonly QueuedProposalRow[],
  ): Promise<QueuedProposalRow[]> {
    const applied: QueuedProposalRow[] = [];
    const now = new Date();
    for (const candidate of candidates) {
      const affected = await this.proposals.transitionIfIn(
        candidate.organizationId,
        candidate.id,
        [
          SlashProposalStatus.PROPOSED,
          SlashProposalStatus.DISPUTED,
          SlashProposalStatus.UNDER_REVIEW,
          SlashProposalStatus.AWAITING_SECOND,
          SlashProposalStatus.UPHELD,
        ],
        {
          status: SlashProposalStatus.OVERTURNED,
          outcome: sweep.outcome,
          resolutionKind: ResolutionKind.ADJUDICATOR,
          resolvedAt: now,
          sweepId: sweep.id,
          countsAsFalsePositive: true,
          decidedByOperatorId: operator.operatorId,
          secondedByOperatorId: null,
          secondedAt: null,
          secondKind: null,
        },
        queryRunner.manager,
      );
      if (affected === 0) continue;

      // Close the objection as a decision would (`writeDisputeDecision`): the
      // provider's case view reads this row, and a swept case left it
      // `UNDER_REVIEW` with the outcome it was overturned from (BUG-R11-O1-03).
      // The second signature goes with it, as on the proposal above.
      if (candidate.disputeId) {
        await queryRunner.manager.update(
          DisputeEntity,
          { organizationId: candidate.organizationId, id: candidate.disputeId },
          {
            state: ARBITRATION_STATE_MAP[sweep.outcome as ArbitrationOutcome],
            outcome: sweep.outcome,
            resolutionKind: ResolutionKind.ADJUDICATOR,
            resolvedAt: now,
            resolvedBy: operator.subject,
            secondedByOperatorId: null,
            secondedAt: null,
            secondKind: null,
          },
        );
      }

      applied.push(candidate);
      await this.lifecycle.appendEvent(queryRunner, {
        organizationId: candidate.organizationId,
        proposalId: candidate.id,
        occurredAt: now,
        kind: 'SWEEP_APPLIED',
        actorType: 'operator',
        actorId: operator.subject,
        summary:
          `Cancelled by a fleet sweep: the same defect was found on another binding and this ` +
          `case was reached without you having to ask.`,
        detail: { sweepId: sweep.id, outcome: sweep.outcome, defectKey: sweep.defectKey },
      });
    }
    return applied;
  }

  /** The side effects of one swept case, after the sweep has committed. Never throws. */
  private async afterSweepApplied(
    sweep: FleetSweepEntity,
    candidate: QueuedProposalRow,
  ): Promise<void> {
    try {
      await this.notifications.notify({
        organizationId: candidate.organizationId,
        event: NotificationEvent.PROVIDER_SLASH_DECIDED,
        title: 'A proposed penalty against your stake was cancelled',
        body:
          'We found a defect on our side affecting several bindings, including yours, and ' +
          'cancelled every penalty it caused. You did not have to raise it.',
        subjectType: 'slash_proposal',
        subjectId: candidate.id,
        dedupeKey: `${candidate.id}:decided`,
        payload: { proposalId: candidate.id, sweepId: sweep.id, outcome: sweep.outcome },
      });
    } catch (error) {
      this.logger.error(
        `fleet sweep ${sweep.id}: case ${candidate.id} was not notified`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    // The fourth and sharpest of the places a case stops standing: the sweep
    // overturns from `UPHELD`, so it reaches cases whose on-chain record may
    // already be executable. This only RECORDS the request; `cancel_slash` is
    // the admin's signature, carried through by `sweepAdminCancels`.
    try {
      await this.requestAdminCancel(candidate.organizationId, candidate.id, 'FLEET_SWEEP');
    } catch (error) {
      this.logger.error(
        `fleet sweep ${sweep.id}: the admin cancel for case ${candidate.id} was not recorded; ` +
          `the closed-case repair pass will ask again`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/**
 * The bare address out of a CAIP-10 account.
 *
 * `slash_proposals.beneficiary_account` is CAIP-10; `SlashExecutorPort` takes a
 * base58 address and calls `address()` on it, which throws on the prefixed
 * form. Converting here keeps both spellings correct in their own layer.
 */
function bareAddress(account: string): string {
  const segments = account.split(':');
  return segments[segments.length - 1];
}

/**
 * A refusal this platform raised before anything reached the chain, by its
 * own code (`SLASH_NO_HARMED_AGENTS`, …), so `chain_last_error` says why a
 * case is not being proposed instead of the catch-all `'transport'`. Still
 * retried: these are facts about the window or the deployment, and a human
 * decides what to do about them.
 */
function localRefusalName(error: unknown): string | null {
  const code = (error as { errorCode?: unknown })?.errorCode;
  return typeof code === 'string' && code.startsWith('SLASH_') ? code.slice(0, 64) : null;
}

/** A Postgres unique violation (23505) on the named constraint or index. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  const driver = (error as { driverError?: { code?: string; constraint?: string } } | null)
    ?.driverError;
  return driver?.code === '23505' && driver.constraint === constraint;
}
