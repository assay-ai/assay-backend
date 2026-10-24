import { Column, Entity, Index } from 'typeorm';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * What one EVM chain's `AssayConfig` says about the pause and the dispute
 * terms, as `EvmChainStateIndexer` last read it — one row per chain.
 *
 * A CACHE of the chain, never its authority: the contracts refuse what they
 * refuse whatever this row says. The backend reads it to refuse early, with a
 * clear error, what the chain would revert anyway (`ProgramPaused`,
 * `AddressBlocked`).
 *
 * `cursor_block` is the last block whose Config events are in Postgres; the
 * indexer resumes after it. `caught_up_at` is when the cursor last reached the
 * head — the lag the operator health endpoint reports is measured from it.
 * Platform data, not tenant data.
 */
@Entity('evm_chain_states')
@Index('uq_evm_chain_states_chain', ['chainId'], { unique: true })
export class EvmChainStateEntity extends AbstractEntityWithoutSoftDelete {
  /** CAIP-2. */
  @Column({ name: 'chain_id', type: 'varchar', length: 64 })
  chainId: string;

  /** `AssayConfig.paused`, from `PauseToggled` and the periodic `paused()` read. */
  @Column({ name: 'paused', type: 'boolean', default: false })
  paused: boolean;

  /** `AssayConfig.arbiter()`, lower-case, or `null` for none. */
  @Column({ name: 'arbiter', type: 'varchar', length: 42, nullable: true })
  arbiter: string | null;

  /** `AssayConfig.slashDelaySeconds()` at the last reconcile. */
  @Column({ name: 'slash_delay_seconds', type: 'integer', nullable: true })
  slashDelaySeconds: number | null;

  @Column({ name: 'cursor_block', type: 'bigint', nullable: true })
  cursorBlock: string | null;

  /**
   * The last block `EvmSlashProposalWatcher` has read (review S-4), apart from
   * `cursor_block`: the two read different contracts on different clocks.
   */
  @Column({ name: 'slash_watch_cursor_block', type: 'bigint', nullable: true })
  slashWatchCursorBlock: string | null;

  /**
   * The last block the slash watcher has back-filled into `evm_slash_records`
   * from before its own cursor (review 2026-10-24 wave 3 N-3); `null` before
   * the first page.
   */
  @Column({ name: 'slash_backfill_cursor_block', type: 'bigint', nullable: true })
  slashBackfillCursorBlock: string | null;

  /** When that back-fill caught up with `slash_watch_cursor_block` (or was not needed). */
  @Column({ name: 'slash_backfill_done_at', type: 'timestamptz', nullable: true })
  slashBackfillDoneAt: Date | null;

  /**
   * The last block `EvmEscrowWithdrawalIndexer` has read (B7), apart from the
   * other two cursors for the same reason they are apart from each other.
   */
  @Column({ name: 'withdrawal_cursor_block', type: 'bigint', nullable: true })
  withdrawalCursorBlock: string | null;

  /** The withdrawal index's last read failure, without the node's prose; cleared by the next good range. */
  @Column({ name: 'withdrawal_last_error', type: 'varchar', length: 256, nullable: true })
  withdrawalLastError: string | null;

  @Column({ name: 'head_block', type: 'bigint', nullable: true })
  headBlock: string | null;

  @Column({ name: 'indexed_at', type: 'timestamptz', nullable: true })
  indexedAt: Date | null;

  @Column({ name: 'caught_up_at', type: 'timestamptz', nullable: true })
  caughtUpAt: Date | null;

  @Column({ name: 'reconciled_at', type: 'timestamptz', nullable: true })
  reconciledAt: Date | null;

  /** The last read failure, without the node's prose (an RPC URL can carry a key). */
  @Column({ name: 'last_error', type: 'varchar', length: 256, nullable: true })
  lastError: string | null;
}
