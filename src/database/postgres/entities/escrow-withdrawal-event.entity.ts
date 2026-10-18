import { Column, Entity, Index } from 'typeorm';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/** What one row records: a request, a cancel (`WithdrawRequested` of `0`), or a claim. */
export enum EscrowWithdrawalEventKind {
  REQUESTED = 'REQUESTED',
  CANCELLED = 'CANCELLED',
  WITHDRAWN = 'WITHDRAWN',
}

/**
 * One `WithdrawRequested` or `EscrowWithdrawn` log of the escrow contract, as
 * `EvmEscrowWithdrawalIndexer` read it past the confirmation depth (B7).
 *
 * Read-side bookkeeping for the buyer's withdrawal history and statements.
 * Nothing that moves money, gates a call or reconciles reads it; the chain
 * stays the record of the balance. Platform data keyed by the buyer's address:
 * the organization is resolved through `buyer_escrows` when it is read.
 */
@Entity('escrow_withdrawal_events')
@Index('uq_escrow_withdrawal_events_log', ['chainId', 'transactionHash', 'logIndex'], {
  unique: true,
})
@Index('idx_escrow_withdrawal_events_buyer', ['chainId', 'buyerAddress', 'blockNumber', 'logIndex'])
export class EscrowWithdrawalEventEntity extends AbstractEntityWithoutSoftDelete {
  @Column({ name: 'chain_id', type: 'varchar', length: 64 })
  chainId: string;

  /** Lower-case `0x` address: the escrow's `buyer`. */
  @Column({ name: 'buyer_address', type: 'varchar', length: 42 })
  buyerAddress: string;

  @Column({ name: 'kind', type: 'varchar', length: 16 })
  kind: EscrowWithdrawalEventKind;

  /**
   * Atomic units. `REQUESTED`: the amount asked for. `WITHDRAWN`: what the
   * contract paid, `min(requested, balance)`. `CANCELLED`: `0`.
   */
  @Column({ name: 'amount', type: 'numeric', precision: 78, scale: 0 })
  amount: string;

  /** `WITHDRAWN` only: the request it filled, which is more than `amount` when a payment landed during the hour. */
  @Column({ name: 'requested', type: 'numeric', precision: 78, scale: 0, nullable: true })
  requested: string | null;

  /** `REQUESTED` only: when it can be claimed, as the contract froze it. */
  @Column({ name: 'available_at', type: 'timestamptz', nullable: true })
  availableAt: Date | null;

  @Column({ name: 'block_number', type: 'bigint' })
  blockNumber: string;

  @Column({ name: 'log_index', type: 'integer' })
  logIndex: number;

  @Column({ name: 'transaction_hash', type: 'varchar', length: 66 })
  transactionHash: string;

  /** The block's own timestamp. */
  @Column({ name: 'block_time', type: 'timestamptz' })
  blockTime: Date;
}
