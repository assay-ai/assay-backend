import { Column, Entity, Index } from 'typeorm';
import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One `withdraw` gas grant — the whole audit trail of a bounded transfer.
 *
 * Never soft-deleted, for the reason `PaymentIntentEntity` is not: this is a
 * record of money that left the relayer, and the row is simultaneously the
 * platform's only proof that an address has already been funded once. A
 * `deleted_at` here would be a way to re-open the once-ever bound.
 *
 * Read `1759400000001-evm-gas-grants.ts` for why the unique index on
 * `account_id` — declared in the migration, not here — is the actual control and
 * the two caps are only the second line.
 */
@Entity('evm_gas_grants')
@Index('idx_evm_gas_grants_created', ['createdAt'])
export class EvmGasGrantEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /** CAIP-2. The chain the ETH was sent on. */
  @Column({ name: 'chain_id', type: 'varchar', length: 64 })
  chainId: string;

  /**
   * CAIP-10, and the column the once-ever unique index is on.
   *
   * `chk_evm_gas_grants_account_on_chain` holds it to `chain_id`'s prefix, so
   * one address cannot occupy two rows by being filed under two chains.
   */
  @Column({ name: 'account_id', type: 'varchar', length: 256 })
  @Index('uniq_evm_gas_grants_account', { unique: true })
  accountId: string;

  /**
   * Wei, as a decimal string. `numeric(78,0)`, like every other on-chain
   * quantity in this schema — money is never a `number` and wei does not fit in
   * one.
   */
  @Column({ name: 'wei', type: 'numeric', precision: 78, scale: 0 })
  wei: string;

  /** `0x` + 64 hex. Unique: one row per transfer, so a retry cannot double-count. */
  @Column({ name: 'transaction_hash', type: 'varchar', length: 66 })
  @Index('uniq_evm_gas_grants_transaction', { unique: true })
  transactionHash: string;
}
