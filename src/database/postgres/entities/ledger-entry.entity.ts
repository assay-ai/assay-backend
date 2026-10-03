import { Column, Entity, Index } from 'typeorm';
import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * The journal.
 *
 * Append-only, and not as a matter of discipline: the migration installs a
 * `BEFORE UPDATE OR DELETE` trigger that raises, so an `UPDATE` issued by
 * anything — this application, a migration, a psql session, an ORM feature
 * nobody remembered — fails at the database. Convention is what a reviewer
 * checks; a trigger is what holds at 3am.
 *
 * Consequently `updatedAt` and `version`, inherited from the base entity, are
 * write-once columns here. They are kept rather than excluded so the table
 * matches every other financial table in shape, and so an attempted mutation
 * fails on the trigger rather than on a missing column.
 */
@Entity('ledger_entries')
@Index('idx_ledger_entries_account_asset_seq', ['organizationId', 'accountId', 'assetId', 'seq'])
@Index('idx_ledger_entries_intent_id', ['organizationId', 'intentId'])
@Index('idx_ledger_entries_hold_id', ['organizationId', 'holdId'])
@Index('idx_ledger_entries_batch_id', ['organizationId', 'batchId'])
export class LedgerEntryEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /**
   * The only total order over the journal.
   *
   * `created_at` ties at microsecond resolution under batch insert and a UUID
   * primary key has no order at all, so a rebuild that needs to replay "the
   * first N entries" — or an auditor reading a receipt — has nothing else to
   * sort by. Assigned by Postgres (`BIGSERIAL`), never by the application:
   * `insert: false` keeps it out of every INSERT statement TypeORM builds.
   */
  @Column({ name: 'seq', type: 'bigint', insert: false, update: false })
  seq: string;

  /** CAIP-10, or one of `INTERNAL_ACCOUNTS`. */
  @Column({ name: 'account_id', type: 'varchar', length: 256 })
  accountId: string;

  @Column({ name: 'entry_type', type: 'varchar', length: 32 })
  entryType: string;

  /**
   * Atomic units, **unsigned**. The direction of the movement comes from
   * `entry_type` via `LEDGER_ENTRY_EFFECTS`, not from a sign here — see
   * `src/modules/ledger/domain/ledger-entry-effect.ts` for why.
   *
   * `numeric(78, 0)` holds any `uint256` exactly. Never `bigint`, never
   * `float`, never a scaled `decimal`: the value is already in atomic units and
   * the asset carries the decimals.
   */
  @Column({ name: 'amount', type: 'numeric', precision: 78, scale: 0 })
  amount: string;

  /** CAIP-19. */
  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  /** The scale `amount` is quoted in. Display only; arithmetic never uses it. */
  @Column({ name: 'decimals', type: 'int' })
  decimals: number;

  // ── Business references — why this entry exists ──────────────────────────

  /**
   * The intent this entry belongs to — a `payment_intents` id for a paid tool
   * call, a `deposit_intents` id for `DEPOSIT_PENDING` / `DEPOSIT_CONFIRM` /
   * `DEPOSIT_REJECT`. `null` for withdrawals, payouts and window-level
   * penalties, which are owed to no single intent.
   *
   * **Deposits do carry one.** `DepositService.settleDeposit` and
   * `DepositFinalityService.promotePendingDeposits` both write the deposit
   * intent's id here, and `DepositFinalityResolution1758100000001`'s backfill
   * depends on it. Earlier documentation claimed deposits leave this `null`;
   * code is authoritative.
   *
   * The two id spaces are distinct tables, so the column is not a foreign key
   * to either; `entry_type` is what says which one to read it against.
   */
  @Column({ name: 'intent_id', type: 'uuid', nullable: true })
  intentId: string | null;

  /** The reservation this entry opens or resolves. `null` for everything else. */
  @Column({ name: 'hold_id', type: 'uuid', nullable: true })
  holdId: string | null;

  /** The flush this entry landed in. `null` for write-through entries. */
  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId: string | null;

  @Column({ name: 'chain_tx_ref', type: 'varchar', length: 256, nullable: true })
  chainTxRef: string | null;
}
