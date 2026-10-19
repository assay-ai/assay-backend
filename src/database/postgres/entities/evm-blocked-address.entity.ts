import { Column, Entity, Index } from 'typeorm';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * One address `AssayConfig.setBlocked` has named on one chain (assay-evm D-19),
 * from its latest `BlockedSet` event and corrected by the periodic
 * `blocked(address)` read. `blocked = false` rows are kept: the address was
 * unblocked, and the row is what the reconcile re-checks.
 *
 * A cache of the chain's blocklist, distinct from the platform's own
 * `account_blocks`; the contracts are the enforcer.
 */
@Entity('evm_blocked_addresses')
@Index('uq_evm_blocked_addresses_chain_address', ['chainId', 'address'], { unique: true })
export class EvmBlockedAddressEntity extends AbstractEntityWithoutSoftDelete {
  @Column({ name: 'chain_id', type: 'varchar', length: 64 })
  chainId: string;

  /** Lower-case `0x` address. */
  @Column({ name: 'address', type: 'varchar', length: 42 })
  address: string;

  @Column({ name: 'blocked', type: 'boolean' })
  blocked: boolean;

  /** `BlockedSet.by` — the admin or the arbiter. `null` when set by a reconcile. */
  @Column({ name: 'set_by', type: 'varchar', length: 42, nullable: true })
  setBy: string | null;

  /** The block of the event this row reflects; an older event never overwrites it. */
  @Column({ name: 'block_number', type: 'bigint', nullable: true })
  blockNumber: string | null;

  @Column({ name: 'log_index', type: 'integer', nullable: true })
  logIndex: number | null;

  @Column({ name: 'transaction_hash', type: 'varchar', length: 66, nullable: true })
  transactionHash: string | null;

  @Column({ name: 'reconciled_at', type: 'timestamptz', nullable: true })
  reconciledAt: Date | null;
}
