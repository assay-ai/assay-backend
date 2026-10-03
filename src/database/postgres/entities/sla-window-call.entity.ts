import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One call's membership of one SLA window. Append-only.
 *
 * ## This is not a copy of `payment_intents`
 *
 * It records something neither `payment_intents` nor `verification_records`
 * contains: **which window this call was counted in**. That is a decision made
 * at posting time and it is not derivable afterwards, because windows close on
 * a verdict count rather than on the clock and a verdict can land long after
 * the call did. Re-deriving membership from `created_at` against a window's
 * bounds silently reassigns late verdicts, so the same window would return
 * different arithmetic depending on when it was asked — and the arithmetic is
 * what a provider disputes.
 *
 * ## It is also the idempotency guarantee
 *
 * `uq_sla_window_calls_intent` is unique on `intentId` **globally**, not per
 * window. BullMQ is at-least-once, so the verification worker can post the same
 * verdict twice; the second insert fails instead of incrementing a counter
 * again. A per-window index would not close it — a retry arriving after the
 * window closed would post the same call to the *next* window and be accepted,
 * which is the worse bug because it is invisible in both windows' totals.
 */
@Entity('sla_window_calls')
@Index('idx_sla_window_calls_window_posted_at', ['windowId', 'postedAt'])
export class SlaWindowCallEntity extends OrganizationScopedEntityWithoutSoftDelete {
  @Column({ name: 'window_id', type: 'uuid' })
  windowId: string;

  /** Unique across the table — one call belongs to at most one window, ever. */
  @Column({ name: 'intent_id', type: 'uuid' })
  intentId: string;

  /**
   * Who called.
   *
   * Kept per call rather than as a counter, because the questions asked of a
   * window's failures are per agent: how many distinct agents the failures came
   * from, and which agents a failing-call summary names
   * (*"agents: ag_7K2 (4), 5 others"*). A counter cannot answer either.
   */
  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  /** One of `VerdictStatus`, or `null` for a call that closed without one. */
  @Column({ name: 'verdict', type: 'varchar', length: 32, nullable: true })
  verdict: string | null;

  /**
   * The failing rule, so the live SLA position screen can say
   * *"MIN_ARRAY_LENGTH 6 · FRESHNESS 3"* without opening every evidence pack in
   * the window.
   */
  @Column({ name: 'reason_code', type: 'varchar', length: 64, nullable: true })
  reasonCode: string | null;

  /** Did this call land in the denominator — i.e. did its verdict move the
   * **quality** metric (`PASS` or `FAIL`)? */
  @Column({ name: 'counted_as_quality', type: 'boolean' })
  countedAsQuality: boolean;

  /** Did it land in the numerator? Implies {@link countedAsQuality}, enforced
   * by a CHECK rather than by the writer. */
  @Column({ name: 'counted_as_failure', type: 'boolean' })
  countedAsFailure: boolean;

  /** The intent's price, minor units — what the window's average price is
   * accumulated from. */
  @Column({ name: 'price_amount', type: 'numeric', precision: 78, scale: 0 })
  priceAmount: string;

  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  /**
   * When the call was posted to the window, which is when it was **judged** —
   * not when it was made.
   *
   * The distinction is the whole reason this table exists, so the column says
   * which of the two it is rather than inheriting `createdAt`'s ambiguity.
   */
  @Column({ name: 'posted_at', type: 'timestamptz' })
  postedAt: Date;
}
