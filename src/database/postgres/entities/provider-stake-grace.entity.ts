import { Column, Entity } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One 7-day grace period, for one binding.
 *
 * A row exists because this binding's stake reading fell below the floor
 * `minimumStakeFor` computed for it. While the row is open, **routing
 * continues** — the provider's screen says `Your traffic is still flowing.` and
 * means it. The row is the platform's record of the promise: when it started,
 * when it runs out, and how far short the provider was when it opened.
 *
 * ## Keyed by binding, not by provider
 *
 * The floor is per binding (`max(floor, priceMultiple × price)`), so one
 * provider is simultaneously above it for a cheap binding and below it for an
 * expensive one. A provider-level row would have to be wrong about one of them.
 * See the migration for the full argument.
 *
 * `organizationId` is inherited and carried for the scope guard — a provider
 * reads only their own grace periods — but it is not the identity. That is
 * `bindingId`, and `uq_provider_stake_grace_open` keys on it.
 *
 * ## No soft delete
 *
 * Two reasons, and the second is mechanical. A grace period is a financial
 * record: it is the reason a binding kept taking paid traffic while
 * under-collateralised, which is exactly what a later dispute would ask about.
 * And TypeORM's `deleted_at IS NULL` filter would hide a row that the partial
 * unique index still counts — so a "deleted" grace period would silently block
 * the next one from ever opening, and the binding would be cut with no
 * countdown at all. Closing a period is {@link resolvedAt}, not a delete.
 *
 * ## Nothing writes here yet
 *
 * `applyStakeGrace` and the monitor job that opens and resolves rows are not
 * wired yet. This is the table they will land on.
 */
@Entity('provider_stake_grace')
export class ProviderStakeGraceEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /** The binding whose floor was not met. `ON DELETE CASCADE` — see the migration. */
  @Column({ name: 'binding_id', type: 'uuid' })
  bindingId: string;

  /**
   * When the shortfall was first observed.
   *
   * Written once and never moved. The countdown the stake screen renders is
   * measured from here, and re-stamping it on a later dip is precisely the
   * restart the partial unique index exists to prevent.
   */
  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  /**
   * When grace runs out — `startedAt` plus the 7-day window.
   *
   * Stored rather than derived so that changing the window length later cannot
   * retroactively shorten a period a provider is already counting down.
   */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /**
   * The floor this binding had to clear, frozen at the moment the period opened.
   *
   * Minor units, as a string — `numeric(78,0)`, like every other money column.
   * Frozen because the stake screen must show "the exact amount needed" against
   * the countdown, and re-deriving it from today's price would answer a
   * different question than the one the clock is timing.
   */
  @Column({ name: 'required_amount', type: 'numeric', precision: 78, scale: 0 })
  requiredAmount: string;

  /** The stake actually read at that moment. Same units, same reason. */
  @Column({ name: 'observed_amount', type: 'numeric', precision: 78, scale: 0 })
  observedAmount: string;

  /**
   * What {@link requiredAmount} and {@link observedAmount} are denominated in.
   *
   * A minor-unit count with no asset is not money: `"10000"` is one cent of
   * USDC or a rounding error of BONK. Every other money-bearing table here
   * carries the denomination beside the amount, and the gate that produces
   * these two numbers refuses the comparison outright when the assets do not
   * agree (`STAKE_ASSET_MISMATCH`, twice over) — storing the result without the
   * asset would discard exactly what those rejections exist to establish.
   *
   * The stake screen also has to render "the exact amount needed" beside the
   * countdown, which is `MoneyUtil.format` and does not run without it.
   */
  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  /**
   * When the period closed, or `null` while it is still running.
   *
   * Closed either way: the provider topped up, or the grace expired and the
   * binding stopped taking paid traffic. **Which of the two it was is
   * {@link resolution}, not something to work out from this timestamp** — see
   * that field for why the inference is wrong at the boundary.
   *
   * This is also the column the partial unique index filters on, so setting it
   * is what frees the binding to open a *later* period.
   */
  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  /**
   * How the period ended — `CURED` | `EXPIRED` — and `null` while it is open.
   *
   * Recorded, deliberately, and not derived from {@link resolvedAt} against
   * {@link expiresAt}. That inference fails at the boundary in **both**
   * directions, and the boundary is where every case that matters sits: a job
   * on a 5-minute tick that notices a top-up 30 seconds after the deadline
   * writes a cure that reads as an expiry, and a sweeper running late writes an
   * expiry indistinguishable from a very late cure. The error is the width of a
   * cron interval and its direction is not fixed, so it cannot be corrected for
   * afterwards either.
   *
   * The writer knows which happened at the instant it closes the row, and
   * nothing ever knows again. The stake history renders this, and a dispute
   * turns on it.
   *
   * Typed `string` with the vocabulary owned by the CHECK constraint, as
   * `BindingTestRunEntity.outcome` is. The two values are fixed in the database
   * where they cannot be worked around; a TypeScript enum belongs with the
   * service that first has to branch on them.
   */
  @Column({ name: 'resolution', type: 'varchar', length: 16, nullable: true })
  resolution: string | null;
}
