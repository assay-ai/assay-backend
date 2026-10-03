import { Column, Entity, Index } from 'typeorm';
import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * One reading of the **total stake bonded across every provider**, taken by the
 * stake monitor's sweep and published on the proof-of-reserves page.
 *
 * ## Why this is a table and not a column on `reconciliation_runs`
 *
 * The obvious place for this figure is beside the vault balance it is shown
 * next to. It does not belong there, for three reasons that are all easy to
 * discover the hard way:
 *
 * 1. **Wrong cardinality.** `reconciliation_runs` is written once per *asset*
 *    per tick. This number is denominated in the settlement program's
 *    `Config.stake_mint` and is a property of the *platform*, not of an asset —
 *    so it would have to be duplicated across rows, or arbitrarily assigned to
 *    one asset's row.
 * 2. **Wrong writer.** That table is written by `ReconciliationJob`; this
 *    reading comes from `StakeMonitorService`, a different module on a
 *    different cron. One of them would be writing a row it does not own.
 * 3. **Wrong failure coupling.** An exception inside `ReconciliationService.
 *    run()` becomes a `RECONCILIATION_BLIND` finding at `CRITICAL`. Folding a
 *    stake RPC into that path would let a stake-RPC outage declare the
 *    *reserves* check blind — two unrelated systems sharing one fate, and a
 *    page telling users their money is unverified because of something that
 *    has nothing to do with their money.
 *
 * There is a fourth reason, and it is the one that matters most on the page:
 * a separate table with its own `readAt` **forces** the UI to say "stake read
 * at X" beside "reconciled at Y". They are two readings taken at two times by
 * two crons, and a column would have quietly implied they were one.
 *
 * ## No `organizationId`
 *
 * Deliberate, and the same exception `ReconciliationRunEntity` documents for
 * itself: this is the whole platform's number. There is no tenant to scope it
 * to, and scoping it would make it wrong. It therefore extends
 * `AbstractEntityWithoutSoftDelete` rather than the organization-scoped base.
 *
 * ## Append-only
 *
 * Never updated, never deleted. A snapshot is a claim about a moment; editing
 * one is editing history that a public page has already published.
 */
@Entity('stake_snapshots')
@Index('idx_stake_snapshots_read_at', ['readAt'])
export class StakeSnapshotEntity extends AbstractEntityWithoutSoftDelete {
  /**
   * When the chain was read — **not** when the row was written, and not when
   * any reconciliation happened. This is the timestamp the page prints beside
   * the figure.
   */
  @Column({ name: 'read_at', type: 'timestamptz' })
  readAt: Date;

  /**
   * CAIP-19 of the settlement program's stake mint. Recorded rather than
   * assumed: the figure is meaningless without knowing what it counts, and a
   * future `Config.stake_mint` change must not silently reinterpret old rows.
   */
  @Column({ name: 'stake_asset', type: 'varchar', length: 256 })
  stakeAsset: string;

  @Column({ name: 'decimals', type: 'int' })
  decimals: number;

  /**
   * `Σ bonded` in minor units, over every provider that has a stake account.
   *
   * Read through `OnChainStakeReaderPort.bondedStakeOf` — **the chain**, never
   * `PROVIDER_STAKE_SOURCE`. The composite source runs in
   * `chain_with_config_fallback` mode and mixes chain readings with values
   * from a JSON file; publishing that under the label "locked in the
   * settlement program" would be an unverifiable claim on the one page whose
   * entire purpose is verifiability.
   */
  @Column({ name: 'bonded_total', type: 'numeric', precision: 78, scale: 0 })
  bondedTotal: string;

  /**
   * How many providers the total covers.
   *
   * **Providers with a stake account**, not providers — the accounts list is
   * filtered to a non-null, non-empty `stakeAuthority` before the read, so a
   * registered provider that has never opened a stake account is not counted.
   * That distinction is published, so it is pinned here rather than left to
   * whoever reads the tile.
   */
  @Column({ name: 'provider_count', type: 'int' })
  providerCount: number;
}
