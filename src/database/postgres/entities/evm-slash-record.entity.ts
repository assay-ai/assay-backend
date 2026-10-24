import { Column, Entity, Index } from 'typeorm';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * One `SlashProposed` record on one EVM chain, as `EvmSlashProposalWatcher`
 * saw it: every record, this platform's own and anybody else's (review
 * 2026-10-24 wave 2 M-2).
 *
 * Two readers:
 *
 * - `EvmRevokedVerifierReaper` releases (`expireSlash`) every standing record
 *   whose verifier can no longer sign — a revoked (stolen) key's records are
 *   released at once on chain (assay-evm D-27) and would otherwise keep the
 *   provider's stake reserved, halting its payments (D-26).
 * - `EvmVoucherRedeemer` asks whether a provider is below its minimum FREE
 *   stake only because of records the platform did not plan (`foreign`) or a
 *   dead key signed (`verifier_unavailable`), so its vouchers are not
 *   forfeited as its own fault.
 *
 * A cache of the chain: every decision re-reads `slashRecordOf` live.
 * `closed_at` is set once the record is seen executed, cancelled or expired.
 * Platform data, no tenant scope.
 */
@Entity('evm_slash_records')
@Index('uq_evm_slash_records_chain_request', ['chainId', 'requestId'], { unique: true })
export class EvmSlashRecordEntity extends AbstractEntityWithoutSoftDelete {
  /** CAIP-2. */
  @Column({ name: 'chain_id', type: 'varchar', length: 64 })
  chainId: string;

  /** 64 lower-case hex characters, no `0x` — `slash_proposal_parts.chain_request_id`'s form. */
  @Column({ name: 'request_id', type: 'varchar', length: 64 })
  requestId: string;

  /** Lower-case `0x` address of the provider's stake authority. */
  @Column({ name: 'provider', type: 'varchar', length: 42 })
  provider: string;

  /** Lower-case `0x` address of the verifier key that signed the attestation. */
  @Column({ name: 'verifier', type: 'varchar', length: 42 })
  verifier: string;

  /** `SlashProposed.reserved`, minor units. */
  @Column({ name: 'reserved', type: 'numeric', precision: 40, scale: 0 })
  reserved: string;

  @Column({ name: 'executable_at', type: 'timestamptz', nullable: true })
  executableAt: Date | null;

  /** The watcher found no matching `slash_proposal_parts` row (UNKNOWN or MISMATCH). */
  @Column({ name: 'foreign', type: 'boolean', default: false })
  foreign: boolean;

  /** The reaper read `canSign(verifier) == false` (revoked or expired key). */
  @Column({ name: 'verifier_unavailable', type: 'boolean', default: false })
  verifierUnavailable: boolean;

  @Column({ name: 'block_number', type: 'bigint', nullable: true })
  blockNumber: string | null;

  @Column({ name: 'transaction_hash', type: 'varchar', length: 66, nullable: true })
  transactionHash: string | null;

  /** Seen executed, cancelled or expired: it no longer reserves anything. */
  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @Column({ name: 'reap_attempts', type: 'integer', default: 0 })
  reapAttempts: number;

  @Column({ name: 'reap_last_error', type: 'varchar', length: 128, nullable: true })
  reapLastError: string | null;
}
