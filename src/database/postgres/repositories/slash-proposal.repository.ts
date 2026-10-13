import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm';

import { SlashProposalEntity } from '../entities/slash-proposal.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * One row of the adjudication queue, projected.
 *
 * A projection rather than the entity for the same reason
 * `UnsettledVerificationRecord` is one: the queue spans tenants and renders six
 * columns, and loading whole proposals to render six columns would pull the
 * arithmetic blob for every open case on every poll.
 */
export interface QueuedProposalRow {
  readonly organizationId: string;
  readonly id: string;
  readonly providerId: string;
  readonly bindingId: string;
  readonly windowId: string | null;
  readonly status: string;
  readonly penaltyAmount: string;
  readonly assetId: string;
  readonly decimals: number;
  readonly platformDecisionDueAt: Date | null;
  readonly rootCauseKey: string | null;
  readonly disputeId: string | null;
}

/** A case whose provider window has elapsed with no objection filed. */
export interface UndisputedProposalRow {
  readonly organizationId: string;
  readonly id: string;
  readonly respondByAt: Date;
}

/** A case whose **platform** window has elapsed with no decision. */
export interface OverdueProposalRow {
  readonly organizationId: string;
  readonly id: string;
  readonly disputeId: string | null;
  readonly platformDecisionDueAt: Date;
}

/**
 * The minimal projection every chain sweep selects on.
 *
 * Just enough to scope a row and re-address it: a sweeper reads one of these,
 * does something with the chain, and comes back with `{ organizationId, id }`
 * to call `claimChainStatus` or `update` on the exact row it read.
 */
export interface ChainSweepRow {
  readonly organizationId: string;
  readonly id: string;
}

/**
 * The extra predicates a chain claim may insist on, beyond `chain_status`.
 *
 * Both are optional and both are about the same thing: the interval between
 * the sweep's `SELECT` and this `UPDATE` is long enough — seconds to minutes
 * of chain work per row, times a batch — for the world to move underneath it.
 * See {@link SlashProposalRepository.claimChainStatus}.
 */
export interface ChainClaimGuards {
  /**
   * Re-claiming a row that is **already at the target** requires its
   * `chain_claimed_at` to be at or before this. A row that is not already at
   * the target is unaffected.
   */
  readonly staleClaimBefore?: Date;
  /** The case `status` must still be one of these when the claim lands. */
  readonly caseStatusIn?: readonly string[];
}

/**
 * The states a case may be in and still be worth reserving stake for.
 *
 * `PROPOSED` through `UPHELD` — everything the provider could still be
 * adjudicated out of, plus the one where they already have been. Terminal
 * states are absent by construction rather than by exclusion, so a state added
 * later has to be considered rather than inherited.
 */
export const CHAIN_PROPOSABLE_STATUSES = [
  'PROPOSED',
  'DISPUTED',
  'UNDER_REVIEW',
  'AWAITING_SECOND',
  'UPHELD',
] as const;

/**
 * The two statuses a case can carry an `executed_at` in, and so the two
 * `markReversedIfExecuted` may move to `REVERSED`.
 *
 * Mirrors the `→ REVERSED` column of `SLASH_PROPOSAL_TRANSITIONS`. It is the
 * *state-machine* half of that method's guard and never the whole of it — what
 * decides a reversal is the money columns. See the method.
 */
const REVERSIBLE_STATUSES = ['EXECUTED', 'OVERTURNED'] as const;

/**
 * The statuses that close a case with no penalty owed: an operator suspended
 * it, or it was overturned. A record still standing on chain for one of these
 * has to be cancelled — see {@link SlashProposalRepository.findClosedStillPending}.
 */
export const CLOSED_WITHOUT_PENALTY_STATUSES = ['CANCELLED', 'OVERTURNED'] as const;

/**
 * `slash_proposals`.
 *
 * Three of the methods here are compare-and-swaps rather than updates, and that
 * is why this class exists rather than the service calling `update` directly.
 * Every one of them decides whether money moves, and each has at least two
 * writers racing for it in production: a sweeper on a tick, an operator on a
 * click, and a retried worker. A read-then-write leaves both winners; a `WHERE`
 * predicate leaves one — the same argument
 * `VerificationRecordRepository.markJudgedIfPending` makes one domain over.
 */
@Injectable()
export class SlashProposalRepository extends OrganizationScopedRepository<SlashProposalEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(SlashProposalEntity, dataSource);
  }

  /**
   * Move the case, but only from where the caller thought it was.
   *
   * Returns the number of rows affected. **Zero is not an error** — it means
   * somebody else moved it first, and the caller has to decide whether that is
   * benign (a sweeper losing to an operator: fine) or a conflict worth
   * reporting (an operator losing to a sweeper: they should be told the case
   * timed out). Collapsing the two here would take that choice away.
   *
   * `expectedFrom` is a list rather than a single value because two callers
   * legitimately accept more than one origin: a decision may arrive from
   * `DISPUTED` or `UNDER_REVIEW`, and a suspension from anywhere non-terminal.
   */
  async transitionIfIn(
    organizationId: string,
    id: string,
    expectedFrom: readonly string[],
    patch: Partial<SlashProposalEntity> & { status: string },
    // A caller's transaction, when the change must commit with something else.
    manager: EntityManager = this.manager,
  ): Promise<number> {
    const result = await manager
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .update()
      .set(patch)
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('id = :id', { id })
      .andWhere('status IN (:...expectedFrom)', { expectedFrom })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * `→ REVERSED`, once and only once, for a case whose money actually moved.
   *
   * Self-check #4 — *"overturning the same verdict twice is blocked"* — is enforced in
   * three places, and this is the first of them. The predicate is
   * `reversed_at IS NULL`, not merely a status: the status alone would let a
   * row that is somehow both reversed and executed be reversed again, and the
   * whole point of a guard is that it holds when something else has already
   * gone wrong.
   *
   * The second place is the CHECK constraint that refuses a reversal on a row
   * that never executed. The third is the program itself, which answers a
   * second `reverse_slash` with `SlashAlreadyReversed`. None of the three is
   * redundant: this one gives a usable error, the constraint survives a second
   * write path, and only the chain's is authoritative about money.
   *
   * ## Why this is not `status = 'EXECUTED'`
   *
   * **The question a reversal asks is "did money leave the provider", and the
   * status is not the column that answers it.** `execute_slash` is
   * permissionless once `executable_at` passes, so a stranger may spend a
   * standing record after an adjudicator has overturned the case;
   * `SlashExecutionService.recordAnExecutionNobodyAskedFor` writes the money
   * columns and leaves `status = 'OVERTURNED'`, because a chain event must not
   * overwrite a human. That row — the only overturned case where the provider
   * is out of pocket — is exactly the one a reversal exists for, and a
   * status-name predicate refuses it.
   *
   * So the predicate is `executed_at IS NOT NULL AND applied_amount IS NOT
   * NULL`, which is the pair `chk_slash_proposals_executed_is_whole` keeps
   * whole and which `reverse_slash.rs` mirrors with
   * `record.status == SlashStatus::Executed`. `status IN (…)` stays beside it
   * as the state-machine half — `SLASH_PROPOSAL_TRANSITIONS` admits `REVERSED`
   * from these two and nothing else — so a row that somehow carries an
   * `executed_at` in a status the table does not admit is still refused here.
   */
  async markReversedIfExecuted(
    organizationId: string,
    id: string,
    reversedAt: Date,
    reversalSignature: string,
    // The override's transaction (review M-3): the status and its register
    // entry commit or roll back together.
    manager: EntityManager = this.manager,
  ): Promise<number> {
    const result = await manager
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .update()
      .set({ status: 'REVERSED', reversedAt, reversalSignature })
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('id = :id', { id })
      .andWhere('status IN (:...reversible)', { reversible: REVERSIBLE_STATUSES })
      // Money left the provider. Both halves, because they are what
      // `chk_slash_proposals_executed_is_whole` binds together and what the
      // program's own `SlashStatus::Executed` means.
      .andWhere('executed_at IS NOT NULL')
      .andWhere('applied_amount IS NOT NULL')
      .andWhere('reversed_at IS NULL')
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Stamp delivery, and start the provider's clock from it.
   *
   * Only ever once: `notified_at IS NULL` in the predicate. A webhook retried
   * three times must not move the deadline three times — and the direction it
   * would move is *later*, which looks generous and is actually the platform
   * silently deciding when its own timelock expires.
   */
  async markNotifiedIfUnnotified(
    organizationId: string,
    id: string,
    notifiedAt: Date,
    respondByAt: Date,
  ): Promise<number> {
    const result = await this.createQueryBuilder('proposal')
      .update()
      .set({ notifiedAt, respondByAt })
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('id = :id', { id })
      .andWhere('notified_at IS NULL')
      .execute();
    return result.affected ?? 0;
  }

  async findOneScoped(organizationId: string, id: string): Promise<SlashProposalEntity | null> {
    return this.findOneBy({ organizationId, id });
  }

  /**
   * Which tenant a proposal belongs to.
   *
   * The one deliberate cross-tenant *point* read on this surface, and the only
   * way an operator route can start from an id alone. Everything the caller
   * does afterwards is scoped to what this returned, so the guard the base
   * class provides is not weakened — it is entered one step later, with the
   * tenant established rather than supplied.
   *
   * Returns null for an id that does not exist, and the caller turns that into
   * the same 404 a deleted proposal would give.
   */
  async tenantOf(id: string): Promise<string | null> {
    const row = await this.manager
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .select('proposal.organization_id', 'organizationId')
      .where('proposal.id = :id', { id })
      .getRawOne<{ organizationId: string }>();
    return row?.organizationId ?? null;
  }

  /**
   * The adjudication queue.
   *
   * **Deliberately cross-organization**, like
   * `VerificationRecordRepository.findUnsettled` and for the same reason: the
   * caller is a platform operator with no tenant of their own, and a queue that
   * had to enumerate tenants would miss the next provider onboarded. The guard
   * on the base class stops a request-serving query that *forgot* its tenant;
   * it cannot stop a deliberate act, and this is one — reached only through
   * `OperatorAuthGuard`, never through `SessionAuthGuard`.
   *
   * ## The ordering is the requirement, not a default
   *
   * Sort by time remaining, then by penalty amount, not FIFO. FIFO against a
   * hard deadline guarantees the oldest case expires first — and under the
   * platform-miss rule an expired case is overturned against us. Sorting by
   * insertion order is therefore not a neutral choice; it is a choice to lose
   * the cases we have held longest.
   *
   * `NULLS LAST` on the deadline: a case in `DISPUTED` before its dispute row
   * is committed has no `platform_decision_due_at` for a moment. Sorting nulls
   * first would put a case with no deadline above one that is minutes from
   * expiring.
   */
  /**
   * The adjudication queue, as a query builder for `paginate` to finish.
   *
   * Returns a builder rather than rows because cursor arithmetic lives in
   * exactly one place — `@shared/api` — and a list that encodes its own
   * position is the thing `surface-consistency.spec.ts` fails the build on. The
   * ordering below is the *filter*; `paginate` adds the sort and the keyset
   * predicate from `ListSpec`.
   *
   * **Deliberately cross-organization**, like
   * `VerificationRecordRepository.findUnsettled` and for the same reason: the
   * caller is a platform operator with no tenant of their own, and a queue that
   * had to enumerate tenants would miss the next provider onboarded. The guard
   * on the base class stops a request-serving query that *forgot* its tenant;
   * it cannot stop a deliberate act, and this is one — reached only through
   * `OperatorAuthGuard`, never through `SessionAuthGuard`.
   *
   * ## `platform_decision_due_at IS NOT NULL` is load-bearing, not defensive
   *
   * `ListSpec` requires every sortable column to be `NOT NULL`, and it gives
   * the reason: a row-value comparison involving `NULL` is `NULL`, which is not
   * `TRUE`, so a row with no value falls out of the pagination entirely —
   * missing, and missing without an error. The column is nullable across the
   * table as a whole, because a `PROPOSED` case has no platform deadline yet.
   *
   * For the three statuses this queue selects it is always set: the same
   * statement that moves a proposal to `DISPUTED` writes the deadline. The
   * predicate states that invariant rather than trusting it, so a future path
   * that reaches `DISPUTED` without a deadline drops the case out of the queue
   * *visibly* — it is absent from a list somebody is watching — instead of
   * invisibly, in the middle of a page.
   */
  queueQueryBuilder(): SelectQueryBuilder<SlashProposalEntity> {
    return this.manager
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .where('proposal.status IN (:...open)', {
        open: ['DISPUTED', 'UNDER_REVIEW', 'AWAITING_SECOND'],
      })
      .andWhere('proposal.platform_decision_due_at IS NOT NULL');
  }

  /**
   * Cases the provider let pass without objecting. Self-check #2's input.
   *
   * Cross-organization for the same reason as `findQueue`, and additionally
   * because this one has no human caller at all — it runs on a scheduler tick.
   */
  async findUndisputedPast(now: Date, limit: number): Promise<UndisputedProposalRow[]> {
    return this.manager
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .select('proposal.organization_id', 'organizationId')
      .addSelect('proposal.id', 'id')
      .addSelect('proposal.respond_by_at', 'respondByAt')
      .where('proposal.status = :proposed', { proposed: 'PROPOSED' })
      .andWhere('proposal.respond_by_at IS NOT NULL')
      .andWhere('proposal.respond_by_at <= :now', { now })
      .orderBy('proposal.respond_by_at', 'ASC')
      .limit(limit)
      .getRawMany<UndisputedProposalRow>();
  }

  /**
   * Cases **we** let pass without deciding: the platform-miss rule.
   *
   * This is the only query in the system whose findings are entirely our own
   * fault, and it exists so that fact is measured rather than absorbed.
   */
  async findOverduePast(now: Date, limit: number): Promise<OverdueProposalRow[]> {
    return this.manager
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .select('proposal.organization_id', 'organizationId')
      .addSelect('proposal.id', 'id')
      .addSelect('proposal.dispute_id', 'disputeId')
      .addSelect('proposal.platform_decision_due_at', 'platformDecisionDueAt')
      .where('proposal.status IN (:...open)', { open: ['DISPUTED', 'UNDER_REVIEW'] })
      .andWhere('proposal.platform_decision_due_at IS NOT NULL')
      .andWhere('proposal.platform_decision_due_at <= :now', { now })
      .orderBy('proposal.platform_decision_due_at', 'ASC')
      .limit(limit)
      .getRawMany<OverdueProposalRow>();
  }

  /**
   * Every case a fleet sweep should reach — including the providers who never
   * complained, which is the entire point of a fleet sweep.
   *
   * Matching is on the defect key over a time window, not on similarity to the
   * source case. That makes the set reproducible from the sweep row: anyone can
   * re-run the same predicate later and get the same list, which is what turns
   * "we swept it" into a checkable claim.
   */
  async findSweepCandidates(
    defectKey: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<QueuedProposalRow[]> {
    return (
      this.manager
        .createQueryBuilder(SlashProposalEntity, 'proposal')
        .select('proposal.organization_id', 'organizationId')
        .addSelect('proposal.id', 'id')
        .addSelect('proposal.provider_id', 'providerId')
        .addSelect('proposal.binding_id', 'bindingId')
        .addSelect('proposal.window_id', 'windowId')
        .addSelect('proposal.status', 'status')
        .addSelect('proposal.penalty_amount', 'penaltyAmount')
        .addSelect('proposal.asset_id', 'assetId')
        .addSelect('proposal.decimals', 'decimals')
        .addSelect('proposal.platform_decision_due_at', 'platformDecisionDueAt')
        .addSelect('proposal.root_cause_key', 'rootCauseKey')
        .addSelect('proposal.dispute_id', 'disputeId')
        // Terminal cases are excluded except EXECUTED, which is precisely the one
        // a sweep must reach: money already moved and the reversal is what the
        // provider is owed. OVERTURNED and CANCELLED need nothing; REVERSED and
        // WAIVED are already whole.
        .where('proposal.status NOT IN (:...done)', {
          done: ['OVERTURNED', 'REVERSED', 'WAIVED', 'CANCELLED'],
        })
        .andWhere('proposal.root_cause_key = :defectKey', { defectKey })
        .andWhere('proposal.proposed_at >= :from', { from })
        .andWhere('proposal.proposed_at <= :to', { to })
        .orderBy('proposal.proposed_at', 'ASC')
        .limit(limit)
        .getRawMany<QueuedProposalRow>()
    );
  }

  /**
   * Cases the chain has not been told about yet: the propose sweep.
   *
   * Two predicates carry the logic:
   *
   * - **`respond_by_at IS NOT NULL`** — the provider has actually been told.
   *   Proposing before delivery would reserve their stake for a case they
   *   cannot answer, and the provider's clock starts on delivery precisely so a
   *   dead webhook does not cost them their window.
   * - **A `PROPOSING` row older than `staleClaimBefore` is included beside the
   *   `NONE` rows.** That is crash recovery (design decision D4, crash point
   *   1), not a race: a process that claims a row `PROPOSING` and then dies
   *   before sending would otherwise strand it forever, because no other query
   *   ever selects a `PROPOSING` row. The chain's `init` on
   *   `["slash", request_id]` refuses a second proposal for the same finding,
   *   so the worst a retry can do is adopt the record that is already there.
   *
   * `now` is accepted for the same reason `findChainExecutable` and
   * `findExecutingToReconcile` take a clock — the scheduler sweep calls all
   * three with one `now` per tick — but this predicate has nothing to compare
   * it against: whether a case is proposable does not depend on the current
   * time, only on `status` and `chain_status`. Left unused rather than forced
   * into a comparison that would change behaviour for no reason.
   */
  async findAwaitingChainProposal(
    _now: Date,
    staleClaimBefore: Date,
    limit: number,
  ): Promise<ChainSweepRow[]> {
    return this.manager
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .select('proposal.organization_id', 'organizationId')
      .addSelect('proposal.id', 'id')
      .where('proposal.status IN (:...live)', { live: [...CHAIN_PROPOSABLE_STATUSES] })
      .andWhere('proposal.respond_by_at IS NOT NULL')
      .andWhere(
        `(proposal.chain_status = 'NONE'
          OR (proposal.chain_status = 'PROPOSING' AND proposal.chain_claimed_at <= :staleClaimBefore))`,
        { staleClaimBefore },
      )
      .orderBy('proposal.proposed_at', 'ASC')
      .limit(limit)
      .getRawMany<ChainSweepRow>();
  }

  /**
   * Cases waiting on the settlement admin's `cancel_slash`. Lean v3's sweep.
   *
   * `chain_status = 'CANCEL_REQUESTED'` and nothing else: the case's own
   * `status` is deliberately not in the predicate, because every route into
   * this state leaves a different one behind — `OVERTURNED` after an
   * adjudication, still `UPHELD` after a downward recalculation — and what the
   * sweep does is identical in both. Ordered by `chain_executable_at` so the
   * records closest to their seven-day expiry grace are looked at first, which
   * is the half of the sweep that has a deadline.
   *
   * Backed by `idx_slash_proposals_awaiting_admin_cancel`.
   */
  async findAwaitingAdminCancel(limit: number): Promise<ChainSweepRow[]> {
    return this.manager
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .select('proposal.organization_id', 'organizationId')
      .addSelect('proposal.id', 'id')
      .where('proposal.chain_status = :requested', { requested: 'CANCEL_REQUESTED' })
      .orderBy('proposal.chain_executable_at', 'ASC')
      .limit(limit)
      .getRawMany<ChainSweepRow>();
  }

  /**
   * Cases closed off chain whose record still mirrors `PENDING`: the repair
   * behind every best-effort cancel request.
   *
   * A suspension (`CANCELLED`) or an overturn (`OVERTURNED`) asks for the
   * on-chain cancel after its own transaction commits, and that request can be
   * lost — the write fails, or the record lands after the case was closed. The
   * row is then selected by nothing: the execute sweep wants `UPHELD` and the
   * admin-cancel sweep wants `CANCEL_REQUESTED`.
   *
   * `AUTO_CHAIN_VOIDED` is excluded on purpose. A case the chain voided at
   * execution time is `CANCELLED` with a `PENDING` mirror by design (see
   * `SlashExecutionService.reservationHeldUntil`), and asking for its cancel
   * is a decision nobody has taken.
   *
   * Reads through `idx_slash_proposals_chain_executable_at` (partial on
   * `chain_status = 'PENDING'`), soonest deadline first.
   */
  async findClosedStillPending(limit: number): Promise<ChainSweepRow[]> {
    return this.manager
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .select('proposal.organization_id', 'organizationId')
      .addSelect('proposal.id', 'id')
      .where('proposal.chain_status = :pending', { pending: 'PENDING' })
      .andWhere('proposal.status IN (:...closed)', { closed: [...CLOSED_WITHOUT_PENALTY_STATUSES] })
      .andWhere(`proposal.resolution_kind IS DISTINCT FROM 'AUTO_CHAIN_VOIDED'`)
      .orderBy('proposal.chain_executable_at', 'ASC')
      .limit(limit)
      .getRawMany<ChainSweepRow>();
  }

  /**
   * Cases both clocks agree may now be paid: the execute sweep.
   *
   * `earliest_execution_at` is the promise the provider was given and
   * `chain_executable_at` is the gate the program enforces; waiting on both
   * means a chain configured with a longer delay than this deployment expects
   * cannot be executed early by us. It cannot stop a *stranger* executing at
   * `chain_executable_at` — `execute_slash` is permissionless — that is what
   * the guard band and `cancel_slash` are for.
   */
  async findChainExecutable(now: Date, limit: number): Promise<ChainSweepRow[]> {
    return this.manager
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .select('proposal.organization_id', 'organizationId')
      .addSelect('proposal.id', 'id')
      .where('proposal.status = :upheld', { upheld: 'UPHELD' })
      .andWhere('proposal.chain_status = :pending', { pending: 'PENDING' })
      .andWhere('proposal.chain_executable_at <= :now', { now })
      .andWhere('proposal.earliest_execution_at <= :now', { now })
      .orderBy('proposal.chain_executable_at', 'ASC')
      .limit(limit)
      .getRawMany<ChainSweepRow>();
  }

  /**
   * Rows the chain may have moved without this platform recording it.
   * The reconcile sweep.
   *
   * Two shapes, and both are "the money may have moved and the row does not
   * say so". Neither is reachable by any other sweep, which is the whole
   * reason this one exists.
   *
   * - **`status = 'EXECUTING'`** — the state exists for exactly the interval
   *   between sending a transaction and learning whether it landed. A row that
   *   has been in it for longer than the claim window is not in flight; it is
   *   orphaned, and the only safe way to find out what happened is to read the
   *   record. Re-submitting is not: with two-phase slashing the `request_id`
   *   lock is spent at *proposal* time, so a second `execute_slash` against an
   *   already-executed record answers `SlashNotPending` — and a caller that
   *   read that as "cancelled" would tell the provider a penalty was dropped
   *   that was in fact taken.
   * - **`chain_status = 'EXECUTED' AND executed_at IS NULL`** — the
   *   adopted-`EXECUTED` park. `proposeDue` found a record already `Executed`
   *   at a request id whose row had never been told, mirrored what the chain
   *   said and deliberately left the case alone. That row is outside
   *   `findAwaitingChainProposal` (`chain_status` is no longer
   *   `NONE`/`PROPOSING`) and outside `findChainExecutable` (it was never
   *   `PENDING`), and it is the one pair no other write path in the service can
   *   produce — every other writer of `chain_status = 'EXECUTED'` sets
   *   `executed_at` in the same statement.
   *
   * `chain_claimed_at IS NULL` is defensive rather than expected — every
   * writer that moves a case into `EXECUTING` sets it in the same statement —
   * but a row that is somehow missing it is exactly as orphaned as one whose
   * claim is stale, so it is included rather than silently skipped. The
   * staleness bound applies to the parked shape too: a park is written with the
   * propose sweep's own `now`, so waiting the claim window out is what keeps a
   * second replica from reconciling a row the first is still writing.
   */
  async findExecutingToReconcile(staleClaimBefore: Date, limit: number): Promise<ChainSweepRow[]> {
    return this.manager
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .select('proposal.organization_id', 'organizationId')
      .addSelect('proposal.id', 'id')
      .where(
        '(proposal.chain_claimed_at IS NULL OR proposal.chain_claimed_at <= :staleClaimBefore)',
        { staleClaimBefore },
      )
      .andWhere(
        `(proposal.status = 'EXECUTING'
          OR (proposal.chain_status = 'EXECUTED' AND proposal.executed_at IS NULL))`,
      )
      .orderBy('proposal.chain_claimed_at', 'ASC')
      .limit(limit)
      .getRawMany<ChainSweepRow>();
  }

  /**
   * Compare-and-swap on the chain mirror, so two scheduler replicas cannot
   * both submit a **proposal** for one case.
   *
   * Only the proposal. The execute claim is `transitionIfIn` on the `status`
   * column (`UPHELD → EXECUTING`), and it does not need this method's guards:
   * `EXECUTING` is not in its own expected set, so a second worker re-evaluates
   * against the committed row and loses outright. `ChainProposalStatus` has no
   * `EXECUTING` member at all — the chain mirror stays `PENDING` for the whole
   * of an execution attempt, because that is what the record says.
   *
   * The scheduler runs single-instance today, which is a deployment fact
   * rather than a guarantee; the CAS costs a few predicates and survives that
   * fact changing. Same shape as `transitionIfIn`, kept separate because it
   * moves a different column (`chain_status`, not `status`) and always writes
   * `chain_claimed_at` alongside it.
   *
   * ## Why `expectedFrom` alone does not serialise, and what `guards` adds
   *
   * The propose sweep must accept `PROPOSING` in `expectedFrom` — that is the
   * whole of `D4` crash point 1, where a claim landed and the process died
   * before sending. But putting the *target* value inside its own expected set
   * destroys the mutual exclusion: worker A flips `NONE → PROPOSING`, worker B
   * re-evaluates against the committed row, still finds `PROPOSING` in the set
   * and is told it won too. Both then sign an attestation for one request id,
   * and two entries land in the verifier signing journal for one judgement.
   * Only the program's `init` lock stops the second penalty — which is a
   * backstop, not a design.
   *
   * {@link ChainClaimGuards.staleClaimBefore} closes it without giving up the
   * recovery: a row that is *not already at the target* claims unconditionally,
   * and a row that is claims only if its own claim has gone stale. The
   * predicate is written to match `findAwaitingChainProposal`'s exactly, so a
   * row the sweep selects is always a row this can claim.
   *
   * {@link ChainClaimGuards.caseStatusIn} closes the other half. The sweep
   * selects on `status` and then does seconds to minutes of chain work per row
   * before reaching the row at the end of the batch; an overturn or a
   * suspension landing in that window would otherwise get a terminal case's
   * stake reserved anyway — and `execute_slash` is permissionless, so a
   * stranded record is somebody else's to execute 72 hours later. Folding the
   * check into the CAS is the only version that closes the window; a re-read
   * and an `if` merely narrows it.
   */
  async claimChainStatus(
    organizationId: string,
    id: string,
    expectedFrom: readonly string[],
    to: string,
    claimedAt: Date,
    guards: ChainClaimGuards = {},
  ): Promise<number> {
    const query = this.createQueryBuilder('proposal')
      .update()
      .set({ chainStatus: to, chainClaimedAt: claimedAt })
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('id = :id', { id })
      .andWhere('chain_status IN (:...expectedFrom)', { expectedFrom });

    if (guards.staleClaimBefore) {
      // `chain_claimed_at IS NOT NULL` rather than treating null as orphaned,
      // because `findAwaitingChainProposal` says the same thing: a row it can
      // never select is a row this must never have to claim.
      query.andWhere(
        '(chain_status <> :claimTarget OR ' +
          '(chain_claimed_at IS NOT NULL AND chain_claimed_at <= :staleClaimBefore))',
        { claimTarget: to, staleClaimBefore: guards.staleClaimBefore },
      );
    }

    if (guards.caseStatusIn) {
      query.andWhere('status IN (:...caseStatusIn)', { caseStatusIn: guards.caseStatusIn });
    }

    const result = await query.execute();
    return result.affected ?? 0;
  }

  /**
   * The false-positive rate's numerator and denominator, over a trailing
   * window.
   *
   * Cross-organization: our false-positive rate is a platform figure, and one
   * computed per tenant would be a different, less useful number that no
   * document asks for.
   */
  async falsePositiveCounts(since: Date): Promise<{ resolved: number; falsePositives: number }> {
    const row = await this.manager
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .select('COUNT(*)::int', 'resolved')
      .addSelect('COUNT(*) FILTER (WHERE proposal.counts_as_false_positive)::int', 'falsePositives')
      .where('proposal.resolved_at IS NOT NULL')
      .andWhere('proposal.resolved_at >= :since', { since })
      .getRawOne<{ resolved: number; falsePositives: number }>();

    return row ?? { resolved: 0, falsePositives: 0 };
  }

  /** How many open cases share each root cause — the queue's grouping column. */
  async rootCauseGroupSizes(keys: readonly string[]): Promise<Map<string, number>> {
    if (keys.length === 0) return new Map();

    const rows = await this.manager
      .createQueryBuilder(SlashProposalEntity, 'proposal')
      .select('proposal.root_cause_key', 'key')
      .addSelect('COUNT(*)::int', 'count')
      .where('proposal.root_cause_key IN (:...keys)', { keys })
      .andWhere('proposal.status IN (:...open)', {
        open: ['DISPUTED', 'UNDER_REVIEW', 'AWAITING_SECOND'],
      })
      .groupBy('proposal.root_cause_key')
      .getRawMany<{ key: string; count: number }>();

    return new Map(rows.map((row) => [row.key, row.count]));
  }
}
