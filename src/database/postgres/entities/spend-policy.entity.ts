import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * The limits a screen shows and the history behind them.
 *
 * ## Append-only, not mutable
 *
 * A change writes a **new row** and stamps `superseded_at` on the old one. The
 * current policy is the row with `superseded_at IS NULL`.
 *
 * The limits screens need "who changed this limit, to what, and when" — an
 * `UPDATE` in place cannot answer that, and a policy limit is exactly the field
 * someone disputes after the fact ("I never authorised a $500 daily cap").
 * Keeping versions also lets a receipt name the `spendPolicyVersion` that was
 * in force when the call was priced, which receipts require and which an
 * overwritten row makes unanswerable.
 *
 * Hence `WithoutSoftDelete`: a superseded policy is not deleted, it is
 * *history*, and history with a `deleted_at` on it is history somebody can
 * quietly edit.
 *
 * ## `agent_id IS NULL` means the organization default
 *
 * A per-agent row overrides the organization row. Modelled as `NULL` rather
 * than a sentinel agent so the partial unique index below can enforce "one
 * live policy per scope" in the database rather than in a service that has to
 * remember to.
 *
 * ## Amounts are atomic units in `numeric(78,0)`
 *
 * Same as every other money column here. A limit compared against a price must
 * be exact and in the same units, and a `bigint` cap on a chain with 18
 * decimals overflows.
 */
@Entity('spend_policies')
@Index('idx_spend_policies_current', ['organizationId', 'agentId'])
export class SpendPolicyEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /** `NULL` = the organization-wide default; otherwise this agent's override. */
  @Column({ name: 'agent_id', type: 'uuid', nullable: true })
  agentId: string | null;

  /** Monotonic per scope. Referenced by receipts as `spendPolicyVersion`. */
  @Column({ name: 'policy_version', type: 'int' })
  policyVersion: number;

  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  @Column({ name: 'decimals', type: 'int' })
  decimals: number;

  /** Largest single call this scope may make. `NULL` = no ceiling. */
  @Column({ name: 'per_call_max', type: 'numeric', precision: 78, scale: 0, nullable: true })
  perCallMax: string | null;

  @Column({ name: 'daily_cap', type: 'numeric', precision: 78, scale: 0, nullable: true })
  dailyCap: string | null;

  @Column({ name: 'monthly_cap', type: 'numeric', precision: 78, scale: 0, nullable: true })
  monthlyCap: string | null;

  /**
   * Velocity, which a cap alone does not express.
   *
   * A $50 daily cap spent evenly and the same $50 spent in nine seconds are the
   * same number and very different events; only the second one looks like a
   * runaway loop. `NULL` = unlimited rate.
   */
  @Column({ name: 'max_calls_per_hour', type: 'int', nullable: true })
  maxCallsPerHour: number | null;

  /**
   * The resolution the runaway loop actually lives at.
   *
   * An hour is too coarse for the failure this layer exists to catch. A retry
   * loop burns a whole daily budget in four minutes while `per_call_max` and
   * `daily_cap` behave exactly as specified on every individual call; the docs'
   * claim that paid calls are *"rate-limited by economics rather than by a
   * counter"* is true over a day and false over a minute. `NULL` = unlimited.
   */
  @Column({ name: 'max_calls_per_minute', type: 'int', nullable: true })
  maxCallsPerMinute: number | null;

  /**
   * Money per hour, the other half of velocity.
   *
   * A call ceiling alone does not stop one expensive tool being called at the
   * permitted rate; this does. Atomic units of {@link assetId}, like every
   * other money column here. `NULL` = unlimited.
   */
  @Column({ name: 'max_spend_per_hour', type: 'numeric', precision: 78, scale: 0, nullable: true })
  maxSpendPerHour: string | null;

  /**
   * The tools this scope may call at all.
   *
   * `NULL` means *every* tool, matching
   * `SpendPolicy.allowedTools: readonly string[] | null`. An empty array is
   * therefore a different and meaningful thing: no tool is allowed, a stop that
   * does not destroy the caps that would say why.
   * `chk_spend_policies_allowed_tools_array` keeps it an array either way.
   *
   * Enforced here at the gateway. The same list belongs in the Privy signer
   * policy, where a platform bug cannot exceed it — until then this is an
   * application-level check and must not be described as more than that.
   */
  @Column({ name: 'allowed_tools', type: 'jsonb', nullable: true })
  allowedTools: string[] | null;

  /** Above this, `tools/call` elicits user approval instead of spending. */
  @Column({
    name: 'require_approval_above',
    type: 'numeric',
    precision: 78,
    scale: 0,
    nullable: true,
  })
  requireApprovalAbove: string | null;

  /**
   * The kill switch, distinct from a zero cap.
   *
   * Zeroing a cap and pausing an agent both stop spending, but they read
   * differently on the receipt and recover differently: `POLICY_AGENT_PAUSED`
   * is one flag to flip back, while a zeroed cap has lost the number it used to
   * hold.
   */
  @Column({ name: 'paused', type: 'boolean', default: false })
  paused: boolean;

  /** Who made the change — a user id, or `system` for a platform action. */
  @Column({ name: 'changed_by', type: 'varchar', length: 128 })
  changedBy: string;

  @Column({ name: 'change_reason', type: 'varchar', length: 512, nullable: true })
  changeReason: string | null;

  /** `NULL` on exactly one row per scope: the live one. */
  @Column({ name: 'superseded_at', type: 'timestamptz', nullable: true })
  supersededAt: Date | null;
}
