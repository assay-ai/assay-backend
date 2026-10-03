import { Column, Entity, Index } from 'typeorm';
import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * A reservation against an account's available balance.
 *
 * Unlike `ledger_entries` this table **is** mutable — a hold has a lifecycle
 * and its status changes. That is not a hole in the append-only rule: the hold
 * row is a projection whose entire history is reconstructible from the
 * `HOLD_CREATE` / `HOLD_RELEASE` / `HOLD_COMMIT` entries that reference it. The
 * row exists so a resolution can be made atomic and conditional with one
 * `UPDATE … WHERE status = 'OPEN'`, which is what makes releasing twice a
 * no-op instead of a double refund.
 */
@Entity('ledger_holds')
@Index('idx_ledger_holds_account_status', ['organizationId', 'accountId', 'status'])
@Index('idx_ledger_holds_expires_at', ['status', 'expiresAt'])
export class LedgerHoldEntity extends OrganizationScopedEntityWithoutSoftDelete {
  @Column({ name: 'account_id', type: 'varchar', length: 256 })
  accountId: string;

  @Column({ name: 'amount', type: 'numeric', precision: 78, scale: 0 })
  amount: string;

  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  @Column({ name: 'decimals', type: 'int' })
  decimals: number;

  /** `OPEN` | `RELEASED` | `COMMITTED`. */
  @Column({ name: 'status', type: 'varchar', length: 16 })
  status: string;

  /**
   * The call this reservation is for.
   *
   * A partial unique index on `(organization_id, intent_id) WHERE status = 'OPEN'`
   * makes "at most one open hold per intent" a database fact. Without it, a
   * retried `createHold` reserves the money twice and the second reservation is
   * never released by anyone.
   */
  @Column({ name: 'intent_id', type: 'uuid' })
  intentId: string;

  /** The `HOLD_CREATE` entry that opened this hold. */
  @Column({ name: 'create_entry_id', type: 'uuid' })
  createEntryId: string;

  /** The `HOLD_RELEASE` or `HOLD_COMMIT` entry that closed it. */
  @Column({ name: 'resolve_entry_id', type: 'uuid', nullable: true })
  resolveEntryId: string | null;

  /** After this, the sweeper releases the hold and the agent gets the money back. */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;
}
