import { Check, Column, Entity, Index } from 'typeorm';
import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * The balance snapshot — a cache, and nothing more.
 *
 * The authoritative balance is `foldEntries(journal)`. This table exists
 * because folding a year of journal on every price check is not a hot path, and
 * it is allowed to exist only because `verifySnapshots()` can prove it equal to
 * that fold on demand. If the two ever disagree, this row is the one that is
 * wrong.
 *
 * It is also the concurrency-control point: `createHold` locks this row
 * `FOR UPDATE` before reading `available`, which is what turns two simultaneous
 * holds against one balance into exactly one winner.
 */
@Entity('account_balances')
@Index('idx_account_balances_account_asset', ['organizationId', 'accountId', 'assetId'], {
  unique: true,
})
@Check('chk_account_balances_non_negative', '"available" >= 0 AND "held" >= 0 AND "pending" >= 0')
export class AccountBalanceEntity extends OrganizationScopedEntityWithoutSoftDelete {
  @Column({ name: 'account_id', type: 'varchar', length: 256 })
  accountId: string;

  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  @Column({ name: 'decimals', type: 'int' })
  decimals: number;

  /** Spendable, and the only bucket a hold may be taken from. */
  @Column({ name: 'available', type: 'numeric', precision: 78, scale: 0, default: '0' })
  available: string;

  /** Reserved against an in-flight call. Spendable by nobody until it resolves. */
  @Column({ name: 'held', type: 'numeric', precision: 78, scale: 0, default: '0' })
  held: string;

  /** Observed on-chain but not final. Owned by the account, reservable by nobody. */
  @Column({ name: 'pending', type: 'numeric', precision: 78, scale: 0, default: '0' })
  pending: string;
}
