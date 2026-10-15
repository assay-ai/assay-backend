import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';
import { StrikeComputationStep } from '@modules/provider/domain/sla/sla-window';

/**
 * A window that breached its declared SLA.
 *
 * ## Which "strike" this is
 *
 * The word is overloaded and this table picks the window-level meaning.
 * "Strike" is also used for the per-call consequence of a `FAIL`, and
 * `VERDICT_CONSEQUENCE.strike` is that meaning; the slash-proposal rule —
 * *"strike or DATA_FAIL → slash proposal"* — uses it for the aggregate event,
 * which only parses if a strike is something other than a per-call `DATA_FAIL`.
 * So a row here is one **window**, and the per-call meaning keeps its existing
 * home on the verdict. The two are joined through `sla_window_calls`.
 *
 * ## Why every number is copied onto the row
 *
 * This is arbitration's input and, through it, the basis for taking a
 * provider's capital. The test it has to pass is that a person in a dispute six
 * months from now can rebuild the entire argument **from this row alone** —
 * without the binding (whose price and declared rate have moved), without the
 * constants file (which may have been tuned), and without re-running
 * verification (which would be a new judgement wearing an old one's clothes).
 * So the observation, the test, the parameters and the penalty are all here,
 * and {@link computation} carries the same numbers again as an ordered
 * derivation — the *"it does not show the arithmetic"* complaint, answered.
 *
 * Never soft-deleted, like every financial record.
 */
@Entity('sla_strikes')
@Index('idx_sla_strikes_binding_recorded_at', ['bindingId', 'recordedAt'])
export class SlaStrikeEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /** Equal to `organizationId` today; carried explicitly — see
   * `SlaWindowEntity.providerId`. */
  @Column({ name: 'provider_id', type: 'uuid' })
  providerId: string;

  @Column({ name: 'binding_id', type: 'uuid' })
  bindingId: string;

  @Column({ name: 'tool_id', type: 'uuid' })
  toolId: string;

  /** Unique — one window is judged once. A second strike on the same window
   * would be a second penalty for one finding, and that is the shape a retried
   * close takes. `ON DELETE RESTRICT`: the window is the evidence. */
  @Column({ name: 'window_id', type: 'uuid' })
  windowId: string;

  /**
   * `RECORDED`, and nothing moves it here.
   *
   * The CHECK admits only that one value on purpose. Arbitration builds the
   * proposal → dispute → arbitration lifecycle and owns this column from then
   * on; leaving the vocabulary open now would invite a producer to invent a
   * state that the process later has to honour.
   */
  @Column({ name: 'status', type: 'varchar', length: 24, default: 'RECORDED' })
  status: string;

  @Column({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt: Date;

  @Column({ name: 'window_opened_at', type: 'timestamptz' })
  windowOpenedAt: Date;

  @Column({ name: 'window_closed_at', type: 'timestamptz' })
  windowClosedAt: Date;

  // ── The observation ───────────────────────────────────────────────────────

  @Column({ name: 'total_calls', type: 'int' })
  totalCalls: number;

  @Column({ name: 'verified_calls', type: 'int' })
  verifiedCalls: number;

  @Column({ name: 'failed_calls', type: 'int' })
  failedCalls: number;

  /** `failedCalls / verifiedCalls`. `double precision`, not `numeric` — a rate
   * is not a balance, and the one exact-decimal rule in this schema is about
   * money. */
  @Column({ name: 'observed_rate', type: 'double precision' })
  observedRate: number;

  // ── The test it failed ────────────────────────────────────────────────────

  /** The declaration **as it stood when the window opened**, not as it stands
   * now. A provider who loosens their SLA after seeing the verdicts is still
   * judged against what they had promised. */
  @Column({ name: 'declared_failure_rate', type: 'numeric', precision: 6, scale: 5 })
  declaredFailureRate: string;

  @Column({ name: 'min_verified_calls', type: 'int' })
  minVerifiedCalls: number;

  @Column({ name: 'z_score', type: 'double precision' })
  zScore: number;

  /** `Z · sqrt(p(1−p)/n)` with `p` the **declared** rate — the sampling error an
   * honest provider is entitled to, not a property of the observation. */
  @Column({ name: 'tolerance', type: 'double precision' })
  tolerance: number;

  /** `declared + tolerance`. A CHECK enforces `observedRate > this`: a strike
   * with no finding behind it must not be storable. */
  @Column({ name: 'effective_threshold', type: 'double precision' })
  effectiveThreshold: number;

  // ── The penalty ───────────────────────────────────────────────────────────

  /**
   * `observed − declared`, measured against the **declaration**, not the
   * threshold.
   *
   * The tolerance decides *whether* a window breached; it is not an allowance
   * the penalty then starts counting from. Charging from the threshold would
   * mean a provider who declared 5% and ran at 15% paid as though they had
   * promised 7.8%.
   */
  @Column({ name: 'excess_rate', type: 'double precision' })
  excessRate: number;

  /**
   * `excessRate × totalCalls`.
   *
   * **No `÷ sample_rate` term.** `observed_rate` is already an estimate of the
   * population rate, so multiplying it by the full window count *is* the
   * extrapolation; dividing again double-counts it. An earlier, superseded
   * reading differed from this by 10× at the prices in the catalogue.
   */
  @Column({ name: 'estimated_bad_calls', type: 'double precision' })
  estimatedBadCalls: number;

  /** `totalCallAmount / totalCalls`, minor units. Recorded because it is the
   * number a provider recognises, though the penalty is computed without the
   * intermediate division. */
  @Column({ name: 'average_price_amount', type: 'numeric', precision: 78, scale: 0 })
  averagePriceAmount: string;

  @Column({ name: 'penalty_multiplier', type: 'double precision' })
  penaltyMultiplier: number;

  /**
   * `estimated_bad × avg_price × multiplier`, minor units. **Uncapped.**
   *
   * The caps live on chain only: `proposeSlash` refuses a penalty above the
   * attested `penaltyAmount`, and the rolling window admits at most
   * `slashCapBps` of the stake at risk. Nothing applies a per-window
   * `min(formula, max($5, 100 × price))` cap. A second, unsigned copy of a
   * chain rule in Postgres is how the two come to disagree the first time one
   * is tuned. `MIN_SLASH_PENALTY` and its
   * carry-forward are the same: whether a finding is worth adjudicating is a
   * property of the proposal, not of the observation.
   */
  @Column({ name: 'penalty_amount', type: 'numeric', precision: 78, scale: 0 })
  penaltyAmount: string;

  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  /** The derivation, step by step, in the order it is shown. */
  @Column({ name: 'computation', type: 'jsonb' })
  computation: readonly StrikeComputationStep[];
}
