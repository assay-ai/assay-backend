import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One SLA measurement window for one binding.
 *
 * Replaces the rolling-UTC-day fold `ProviderSlaWindowsService` computed before
 * this table existed — see `1757600000000-create-sla-windows-and-strikes.ts`
 * for the three reasons a fold could not carry a penalty.
 *
 * Never soft-deleted: this row is the reason a provider's stake was or was not
 * proposed for slashing.
 *
 * ## The frozen block is the point of the table
 *
 * `declaredFailureRate` through `penaltyMultiplier` are copies, taken when the
 * window opened, of values that live elsewhere and change. That is not
 * denormalisation for speed. A change to the declared rate must take effect *at
 * the next window boundary, never mid-window, and recorded on the row so a
 * dispute is judged against the declared rate as it was* — and the same
 * argument applies with more force to `minVerifiedCalls` and `zScore`, which
 * are platform constants: re-deciding a closed window by editing a file is the
 * one thing a penalty must never be able to do.
 */
@Entity('sla_windows')
@Index('idx_sla_windows_binding_opened_at', ['bindingId', 'openedAt'])
export class SlaWindowEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /**
   * The provider this window measures.
   *
   * Equal to `organizationId` today — a provider *is* an organization on this
   * platform — and stored separately anyway. That identity is load-bearing in
   * several places and written down in none of them, so a table created after
   * it was noticed carries both columns rather than quietly relying on it.
   * `organizationId` is the scope guard; this is the subject.
   */
  @Column({ name: 'provider_id', type: 'uuid' })
  providerId: string;

  /**
   * The binding measured. `ON DELETE CASCADE`.
   *
   * Per binding, not per provider, because `slaFailureRate` is per binding: one
   * provider running a $0.001 search binding and a $1.00 lookup binding has
   * declared two different numbers and must be measured against each. A
   * provider-level window would judge both against whichever declaration
   * happened to be read.
   */
  @Column({ name: 'binding_id', type: 'uuid' })
  bindingId: string;

  /**
   * Denormalised from the binding so the peer-distribution query on the SLA
   * workbench — closed windows across every binding on one tool — needs no
   * join.
   */
  @Column({ name: 'tool_id', type: 'uuid' })
  toolId: string;

  /**
   * 1-based, per binding. The provider-facing name of the window (`w_4482` on
   * the live SLA position screen) is rendered from this, so a window can be
   * quoted in a dispute without a uuid. Unique per binding in the database.
   */
  @Column({ name: 'sequence', type: 'int' })
  sequence: number;

  /** `OPEN` | `CLOSED` — `SlaWindowStatus`. Vocabulary owned by the CHECK. */
  @Column({ name: 'status', type: 'varchar', length: 16 })
  status: string;

  /**
   * `WITHIN_SLA` | `INSUFFICIENT_SAMPLE` | `BREACH_PROPOSED` — `SlaWindowOutcome`.
   * `null` while open.
   *
   * `INSUFFICIENT_SAMPLE` is stored as an outcome rather than left implicit
   * because the UI has to *show* it: a provider needs to watch thin windows not
   * convict them, repeatedly, on ordinary days, or the gate is not believable
   * on the day it matters.
   */
  @Column({ name: 'outcome', type: 'varchar', length: 24, nullable: true })
  outcome: string | null;

  @Column({ name: 'opened_at', type: 'timestamptz' })
  openedAt: Date;

  /**
   * `openedAt + maxAgeMs`. Stored, not derived, for the same reason
   * `provider_stake_grace.expires_at` is: changing the constant later must not
   * retroactively move a deadline a provider is already counting down to.
   */
  @Column({ name: 'deadline_at', type: 'timestamptz' })
  deadlineAt: Date;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  // ── Frozen at open ────────────────────────────────────────────────────────

  /** The binding's `slaFailureRate` as it stood when this window opened. */
  @Column({ name: 'declared_failure_rate', type: 'numeric', precision: 6, scale: 5 })
  declaredFailureRate: string;

  /** `MIN_VERIFIED_CALLS` at open. Below it, no penalty is possible. */
  @Column({ name: 'min_verified_calls', type: 'int' })
  minVerifiedCalls: number;

  /** `SLA_Z_SCORE` at open — the multiplier in `Z·sqrt(p(1−p)/n)`. */
  @Column({ name: 'z_score', type: 'double precision' })
  zScore: number;

  /** `SLA_WINDOW_MAX_AGE_MS` at open. `bigint` reaches this side as a string. */
  @Column({ name: 'max_age_ms', type: 'bigint' })
  maxAgeMs: string;

  @Column({ name: 'warning_ratio', type: 'double precision' })
  warningRatio: number;

  @Column({ name: 'warning_min_sample_fraction', type: 'double precision' })
  warningMinSampleFraction: number;

  @Column({ name: 'penalty_multiplier', type: 'double precision' })
  penaltyMultiplier: number;

  // ── Counters ──────────────────────────────────────────────────────────────

  /** Every call posted to this window, whatever its verdict. The `window_calls`
   * term in `estimated_bad = excess_rate × window_calls`. */
  @Column({ name: 'total_calls', type: 'int', default: 0 })
  totalCalls: number;

  /**
   * Calls carrying a **quality** verdict — `PASS` or `FAIL`, and nothing else.
   *
   * Not "has a verdict". The earlier fold counted
   * `verificationVerdict IS NOT NULL`, which swept in `SKIPPED` (nobody
   * checked), `MISAPPLIED` (our policy was wrong) and `DEGRADED` (our
   * infrastructure was down) — three verdicts the vocabulary states are not the
   * provider's fault. Each one added to the denominator understated the failure
   * rate by an amount that varied with the sample rate. The rule is read off
   * `VERDICT_CONSEQUENCE.metric`, so an eighth status is classified by its own
   * consequence row.
   */
  @Column({ name: 'verified_calls', type: 'int', default: 0 })
  verifiedCalls: number;

  /** The subset of {@link verifiedCalls} whose verdict was `FAIL`. */
  @Column({ name: 'failed_calls', type: 'int', default: 0 })
  failedCalls: number;

  /**
   * Sum of `price_amount` over every posted call, minor units.
   *
   * Accumulated rather than joined at close, because the penalty formula needs
   * the average price *of this window's traffic* and a binding's price changes.
   */
  @Column({ name: 'total_call_amount', type: 'numeric', precision: 78, scale: 0, default: 0 })
  totalCallAmount: string;

  /** What {@link totalCallAmount} is denominated in. A minor-unit count with no
   * asset is not money. */
  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  // ── Early warning ─────────────────────────────────────────────────────────

  /**
   * The highest warning level already delivered — `WARNING` | `CRITICAL`, or
   * `null`. `SlaWarningLevel`.
   *
   * Monotonic, and stored here rather than left to the notification suppression
   * store because suppression is Redis and fails toward *sending*. That is the
   * right failure direction for a balance alert and the wrong one here: a Redis
   * flush mid-window would re-warn a provider about a window they already acted
   * on, which is how a useful signal becomes noise.
   */
  @Column({ name: 'warning_level', type: 'varchar', length: 16, nullable: true })
  warningLevel: string | null;

  @Column({ name: 'warned_at', type: 'timestamptz', nullable: true })
  warnedAt: Date | null;

  @Column({ name: 'critical_warned_at', type: 'timestamptz', nullable: true })
  criticalWarnedAt: Date | null;

  /**
   * Set when the window closed `INSUFFICIENT_SAMPLE`: this binding's sample
   * rate should be escalated until 400 verified calls is reachable.
   *
   * **Nothing reads it yet.** Thin bindings must escalate sampling: without
   * escalation a low-volume binding can never reach the gate, so its stake
   * secures nothing and the gate becomes a safe harbour precisely where a bad
   * actor would sit. Acting on it needs a `SampleRateOverride` threaded into
   * `deriveSampleRate`'s only production caller —
   * `verification-settlement.service.ts` `judge()` — which is the same single
   * line `EXPLORING_BINDING` has been waiting on. Writing the flag makes the
   * decision durable and names the seam; the wiring is deferred.
   */
  @Column({ name: 'sampling_escalation_requested', type: 'boolean', default: false })
  samplingEscalationRequested: boolean;
}
