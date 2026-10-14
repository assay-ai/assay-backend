import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * A proposal to take a provider's capital, with a clock on it.
 *
 * This is the object the slash-proposal case screen renders and the row the
 * adjudication queue orders. It is the first thing in the system that reads
 * `sla_strikes`: the SLA window service wrote strikes with
 * `status = 'RECORDED'` and nothing ever moved them, because the lifecycle
 * lives here.
 *
 * ## `status` is the case; `outcome` is the judgement
 *
 * Two columns, because they answer different questions and a single one would
 * lose an answer.
 *
 * ```text
 *   PROPOSED ──── provider objects, in window ────► DISPUTED
 *      │                                              │
 *      │ nobody objects, respond_by_at passes         │ operator claims it
 *      │ (AUTO_UNDISPUTED)                            ▼
 *      │                                        UNDER_REVIEW
 *      │                                              │
 *      │                                     adjudicator decides
 *      │                                              ▼
 *      │                                       AWAITING_SECOND
 *      │                                              │
 *      │                              second signs ───┤─── second objects
 *      │                                              │      (back to
 *      ▼                                              ▼    UNDER_REVIEW)
 *   UPHELD ◄─────────────────────────────────► OVERTURNED (terminal)
 *      │
 *      │ earliest_execution_at has passed
 *      ▼
 *   EXECUTING ──► EXECUTED ──── later overturn ──► REVERSED (terminal)
 *
 *   WAIVED    — below the de-minimis floor, never adjudicated (terminal)
 *   CANCELLED — S-1, suspended by an operator pre-attestation (terminal)
 * ```
 *
 * `outcome` carries which of the six outcomes the adjudicator chose. It is NULL
 * for every automatic resolution, and the CHECK
 * `chk_slash_proposals_outcome_needs_adjudicator` makes that exact: an outcome
 * is a judgement, and there are three ways a case ends without one.
 *
 * ## The word UPHELD means the opposite here and on `disputes`
 *
 * `slash_proposals.status = 'UPHELD'` — the *proposal* stands, the provider
 * loses. `disputes.state = 'UPHELD'` — the *objection* stands, the provider
 * wins. Both are the settled usage in their own table and neither can be
 * renamed without rewriting the other's history. `ARBITRATION_STATE_MAP` in the
 * arbitration domain is the single place the translation lives, and a test
 * asserts it in both directions.
 *
 * ## Why `penalty_amount` is uncapped and `applied_amount` is separate
 *
 * `penalty_amount` is copied from the strike's formula result. The 10%-of-stake
 * daily cap and the per-window ceiling are enforced **on chain** against a
 * signed attestation; a second unsigned copy of a consensus rule in Postgres is
 * how the two come to disagree. `applied_amount` is written back from the
 * confirmed transaction, so the gap between the two is visible per case rather
 * than inferred — a shortfall is "discharged, not carried".
 *
 * ## `chain_request_id` is the replay lock, mirrored
 *
 * The program burns a `request_id` permanently on a successful `slash`. Storing
 * it here, unique, means a retried submission cannot mint a second penalty for
 * one finding, and a case whose id was already burned is diagnosable without a
 * chain read. It is derived deterministically from `id`, never randomly — a
 * random one would make the retry the very thing it is meant to prevent.
 */
@Entity('slash_proposals')
@Index('idx_slash_proposals_provider_proposed_at', ['providerId', 'proposedAt'])
export class SlashProposalEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /**
   * The provider whose stake is at risk. Equal to `organizationId` today —
   * `providerId == organizationId` is load-bearing across this surface — and
   * kept as its own column because that identity is a property of how providers
   * are onboarded, not a fact about slashing.
   */
  @Column({ name: 'provider_id', type: 'uuid' })
  providerId: string;

  @Column({ name: 'binding_id', type: 'uuid' })
  bindingId: string;

  @Column({ name: 'tool_id', type: 'uuid' })
  toolId: string;

  /** `SLA_STRIKE` | `DATA_FAIL` — the two doors a slash proposal can come from. */
  @Column({ name: 'source', type: 'varchar', length: 16 })
  source: string;

  /** Set exactly when `source = 'SLA_STRIKE'`. Unique: one proposal per strike. */
  @Column({ name: 'strike_id', type: 'uuid', nullable: true })
  strikeId: string | null;

  /** Set exactly when `source = 'DATA_FAIL'`. Unique: one proposal per verdict. */
  @Column({ name: 'verdict_id', type: 'uuid', nullable: true })
  verdictId: string | null;

  /**
   * The window the finding came from, when there is one.
   *
   * Denormalised off the strike rather than joined, because a `DATA_FAIL`
   * proposal has a window too (the call belonged to one) and the queue renders
   * the label on every row.
   */
  @Column({ name: 'window_id', type: 'uuid', nullable: true })
  windowId: string | null;

  @Column({ name: 'status', type: 'varchar', length: 24 })
  status: string;

  /** 32 bytes, lower-case hex. Unique. Derived from `id`. */
  @Column({ name: 'chain_request_id', type: 'char', length: 64 })
  chainRequestId: string;

  /** The uncapped formula result, in minor units. */
  @Column({ name: 'penalty_amount', type: 'numeric', precision: 78, scale: 0 })
  penaltyAmount: string;

  /** What the chain actually took. Null until `EXECUTED`. */
  @Column({
    name: 'applied_amount',
    type: 'numeric',
    precision: 78,
    scale: 0,
    nullable: true,
  })
  appliedAmount: string | null;

  /**
   * The platform's share of the penalty, in minor units.
   *
   * Recorded here and **not** in the ledger. It is paid to
   * `economics.treasury`, which is not the vault, and the reconciler compares
   * the vault against total ledger liabilities — a booked platform share would
   * add a liability nothing covers and trip proof of reserves.
   *
   * Read off the chain's own `SlashRecord`, never recomputed: `slash` takes the
   * rate from the per-provider `ProviderTerms` account, so it is a contract
   * term rather than a constant.
   */
  @Column({
    name: 'platform_amount',
    type: 'numeric',
    precision: 78,
    scale: 0,
    nullable: true,
  })
  platformAmount: string | null;

  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  @Column({ name: 'decimals', type: 'int' })
  decimals: number;

  /**
   * CAIP-10 account of the harmed agent, who receives the 60%.
   *
   * Nullable, and this is the honest half of a gap rather than an oversight:
   * the settlement model describes a window-level penalty distributed pro-rata
   * across every agent who spent in the window, and one attestation carries
   * exactly one `beneficiary`. Until that is decided (it is open work in slash
   * execution), a window proposal has no single beneficiary to name and cannot
   * execute.
   */
  @Column({ name: 'beneficiary_account', type: 'varchar', length: 256, nullable: true })
  beneficiaryAccount: string | null;

  @Column({ name: 'proposed_at', type: 'timestamptz' })
  proposedAt: Date;

  /**
   * When the notification was **delivered**, which is when the provider's clock
   * starts. A webhook to a dead endpoint must not consume their appeal window,
   * so `respond_by_at` stays NULL until this is set.
   */
  @Column({ name: 'notified_at', type: 'timestamptz', nullable: true })
  notifiedAt: Date | null;

  @Column({ name: 'acknowledged_at', type: 'timestamptz', nullable: true })
  acknowledgedAt: Date | null;

  /** Derived from `notified_at`, never from `proposed_at`. */
  @Column({ name: 'respond_by_at', type: 'timestamptz', nullable: true })
  respondByAt: Date | null;

  /**
   * Our own deadline, set when a dispute is filed.
   *
   * The one rule that makes understaffing our cost instead of the provider's:
   * miss it and the case is automatically overturned. Nothing else puts a clock
   * on us.
   */
  @Column({ name: 'platform_decision_due_at', type: 'timestamptz', nullable: true })
  platformDecisionDueAt: Date | null;

  /**
   * The timelock. The case screen states it as a promise — "never before that
   * deadline, even if you do nothing" — and
   * `chk_slash_proposals_execution_respects_timelock` states it as a
   * constraint, so a service that forgets cannot break it.
   */
  @Column({ name: 'earliest_execution_at', type: 'timestamptz' })
  earliestExecutionAt: Date;

  /**
   * What the chain thinks of this judgement. `ChainProposalStatus`.
   *
   * `NONE` for every row written before two-phase slashing and for every row
   * whose notification has not been delivered yet — a case the provider was
   * never told about must not reserve their stake.
   */
  @Column({ name: 'chain_status', type: 'varchar', length: 16, default: 'NONE' })
  chainStatus: string;

  /**
   * Bumped whenever a standing on-chain proposal is cancelled and re-proposed —
   * today, only for `UPHELD_RECALCULATED`.
   *
   * The chain burns a `request_id` permanently, so a re-proposal needs a fresh
   * one. Epoch 0 reproduces the original derivation exactly, so no existing
   * row's `chain_request_id` moves.
   */
  @Column({ name: 'chain_epoch', type: 'int', default: 0 })
  chainEpoch: number;

  /** `SlashRecord.proposed_at`, read off the account. */
  @Column({ name: 'chain_proposed_at', type: 'timestamptz', nullable: true })
  chainProposedAt: Date | null;

  /**
   * `SlashRecord.executable_at` — `proposed_at + Config.slash_delay_seconds`.
   *
   * Not the same thing as `earliest_execution_at`, which is this platform's
   * promise to the provider. Two things an earlier version of this comment got
   * wrong, both of which cost a guard:
   *
   * - **`earliest_execution_at` moves.** `ArbitrationService.extendDeadline`
   *   (`S-8`) pushes it forward, by up to 14 days.
   * - **This is not "always at or after the promise".** It is frozen when the
   *   record is written and nothing off-chain can move it, so an extension made
   *   after the propose, or a record adopted at an older `proposed_at`, puts it
   *   BEFORE the promise. `execute_slash` is permissionless, so that gap is a
   *   window in which any stranger may take the penalty while the provider is
   *   still inside the time they were given.
   *
   * Three things keep the two in the right order, and none of them is this
   * column: `extendDeadline` refuses an extension past a standing door,
   * `proposeDue` defers a propose that would open one early, and the executor
   * waits on `max(both clocks)` so at least this process never goes first.
   */
  @Column({ name: 'chain_executable_at', type: 'timestamptz', nullable: true })
  chainExecutableAt: Date | null;

  /**
   * `SlashRecord.reserved` — the stake the proposal put beyond withdrawal.
   *
   * `min(penalty, slash_cap_bps of at_risk, at_risk − pending_slash)`, so it is
   * routinely smaller than `penalty_amount` and is the number a provider's
   * capital screen should be netting off, not the gross judgement.
   */
  @Column({ name: 'chain_reserved', type: 'numeric', precision: 78, scale: 0, nullable: true })
  chainReserved: string | null;

  /**
   * The `propose_slash` transaction. Null when the record was adopted rather
   * than sent by this process — inventing one would put a transaction in the
   * case timeline that nobody can look up.
   */
  @Column({ name: 'chain_proposal_signature', type: 'varchar', length: 256, nullable: true })
  chainProposalSignature: string | null;

  /** When `PROPOSING`/`EXECUTING` was claimed, so a crashed claim can be reaped. */
  /** The chain's `disputedAt` (D-19), when the provider disputed the record on chain. */
  @Column({ name: 'chain_disputed_at', type: 'timestamptz', nullable: true })
  chainDisputedAt: Date | null;

  /**
   * How many of the current epoch's parts are `DISPUTED` on chain (audit
   * E-4). A dispute freezes only its part: the mirror stays `PENDING` while
   * any part is pending (and those parts keep executing), and is `DISPUTED`
   * only when every live part is. `PENDING` with a non-zero count is a partly
   * disputed case.
   */
  @Column({ name: 'chain_disputed_parts', type: 'integer', default: 0 })
  chainDisputedParts: number;

  /**
   * When the provider WON an on-chain dispute of this case (follow-up B7): a
   * record cancelled while `DISPUTED`, or expired as `DisputeUnresolved`. Set,
   * the case is never re-proposed and its window's calls are never put in a
   * new case.
   */
  @Column({ name: 'chain_dispute_won_at', type: 'timestamptz', nullable: true })
  chainDisputeWonAt: Date | null;

  @Column({ name: 'chain_claimed_at', type: 'timestamptz', nullable: true })
  chainClaimedAt: Date | null;

  /**
   * The program's own name for the last refusal — `VerifierRevoked`, never `6011`.
   *
   * **LOAD-BEARING. This column is not only a diagnostic: control flow branches
   * on one of its values.** `SlashExecutionService.executeDue`
   * (`src/modules/slash/services/slash-execution.service.ts:764`) does
   * `if (proposal.chainLastError === EXECUTED_BEYOND_DECISION) continue;`, where
   * the constant is `'ExecutedBeyondDecision'`, defined at the same file's line
   * 141 and written at line 1396. That `continue` is the **only** thing keeping
   * a case whose chain execution the row cannot legally record out of the
   * executable sweep — without it the row is re-selected, re-read and re-logged
   * on every tick, for ever.
   *
   * So clearing, truncating, back-filling or repurposing this column removes a
   * loop guard. Any migration or cleanup job that touches it must preserve
   * `'ExecutedBeyondDecision'` exactly, and any code that widens the value space
   * must not collide with it. Representing that state properly needs a column or
   * a status of its own; until then this string is the state.
   */
  @Column({ name: 'chain_last_error', type: 'varchar', length: 64, nullable: true })
  chainLastError: string | null;

  @Column({ name: 'disputed_at', type: 'timestamptz', nullable: true })
  disputedAt: Date | null;

  @Column({ name: 'dispute_id', type: 'uuid', nullable: true })
  disputeId: string | null;

  /**
   * `ADJUDICATOR` | `AUTO_UNDISPUTED` | `AUTO_PLATFORM_MISS` | `AUTO_DE_MINIMIS`
   * | `AUTO_CHAIN_VOIDED`.
   */
  @Column({ name: 'resolution_kind', type: 'varchar', length: 24, nullable: true })
  resolutionKind: string | null;

  /**
   * One of the six outcomes. NOT NULL exactly when `resolutionKind` is
   * `'ADJUDICATOR'`, with one exception: `AUTO_CHAIN_VOIDED` may land on a case
   * an adjudicator already upheld, and the human's judgement is left standing
   * on the row while the *closure* is recorded as automatic. See
   * `chk_slash_proposals_outcome_needs_adjudicator`.
   */
  @Column({ name: 'outcome', type: 'varchar', length: 40, nullable: true })
  outcome: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ name: 'decided_by_operator_id', type: 'uuid', nullable: true })
  decidedByOperatorId: string | null;

  /** The second signature. Constrained at the database to be a different person. */
  @Column({ name: 'seconded_by_operator_id', type: 'uuid', nullable: true })
  secondedByOperatorId: string | null;

  @Column({ name: 'seconded_at', type: 'timestamptz', nullable: true })
  secondedAt: Date | null;

  /** `SIGNED` | `OBJECTED`. An objection carries a reason too. */
  @Column({ name: 'second_kind', type: 'varchar', length: 16, nullable: true })
  secondKind: string | null;

  @Column({ name: 'executed_at', type: 'timestamptz', nullable: true })
  executedAt: Date | null;

  @Column({ name: 'execution_signature', type: 'varchar', length: 256, nullable: true })
  executionSignature: string | null;

  @Column({ name: 'reversed_at', type: 'timestamptz', nullable: true })
  reversedAt: Date | null;

  @Column({ name: 'reversal_signature', type: 'varchar', length: 256, nullable: true })
  reversalSignature: string | null;

  /**
   * Cases sharing a suspected root cause are grouped and decided once.
   * Free-form on purpose: the key is whatever the operator judged the cases to
   * have in common, and a closed vocabulary would need to be complete before
   * the first incident.
   */
  @Column({ name: 'root_cause_key', type: 'varchar', length: 128, nullable: true })
  rootCauseKey: string | null;

  /** Set on every proposal a fleet sweep reached, including uncomplained ones. */
  @Column({ name: 'sweep_id', type: 'uuid', nullable: true })
  sweepId: string | null;

  /**
   * Read by the false-positive metric. Stored rather than derived, because the
   * outcome taxonomy may grow and a historical false-positive rate must not
   * move when it does.
   */
  @Column({ name: 'counts_as_false_positive', type: 'boolean', default: false })
  countsAsFalsePositive: boolean;
}
