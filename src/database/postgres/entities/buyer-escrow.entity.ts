import { Check, Column, Entity, Index } from 'typeorm';
import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * The mirror of one buyer's on-chain escrow, and the allocator for the sequence
 * numbers their vouchers carry.
 *
 * ## What is authoritative here, and what is a copy
 *
 * `escrow_account_id` and `escrow_asset_account_id` are **copies** — on Solana
 * both are derived from the account pubkey by the program and could be
 * recomputed at any time; on eip155 both are the escrow contract itself. They
 * are stored so that answering `GET /escrow/next-seq` is one indexed read rather
 * than a PDA derivation per call, and so the reconciler can list every escrow it
 * must check without walking the agent table.
 *
 * `next_seq` is **not** a copy. It is the only durable record of which sequence
 * numbers this platform has handed out, and nothing on chain can reproduce it:
 * `BuyerEscrow.seq_high` on chain is the highest number *redeemed*, which lags
 * by every voucher still in flight and skips every number issued and never used.
 *
 * ## Why the allocator is a Postgres column and not a Redis counter
 *
 * Redis would be the obvious home, and the argument against it is that
 * flushing Redis must never enable a double spend: an `INCR` counter that
 * a flush resets to 1 re-issues numbers the chain has already redeemed. The
 * buyer signs them, the platform serves the call, and the redemption dies with
 * `VoucherSeqNotIncreasing` — money held, call served, nothing collected.
 * Worse, a re-issued seq can collide with a voucher still in flight.
 *
 * Redis keeps only `oldest_pending_seq`, which is a *cache of a query*. Losing
 * it costs one indexed query per call and cannot cost correctness.
 *
 * ## Keyed on the account alone, deliberately
 *
 * `account_id` is unique on its own. Neither `organization_id` nor `asset_id` is
 * part of the identity, and the asset is the one worth saying out loud: the
 * chain has **one escrow per buyer and one sequence space**, because
 * `["escrow", buyer]` carries a single `seq_high` and its token account is the
 * ATA for the single mint `Config` fixes. A second row for one account would be
 * a second allocator for one on-chain counter — it would hand out a `seq` from
 * one row's counter alongside the other row's escrow address, and the
 * reconciler's self-heal would fight itself across the two.
 *
 * Two agents sharing a `primary_account_id` therefore share one escrow, one
 * balance and one sequence window, which is already true of their ledger
 * balance today.
 */
@Entity('buyer_escrows')
@Index('uq_buyer_escrows_account', ['accountId'], { unique: true })
@Index('idx_buyer_escrows_organization_id', ['organizationId'])
@Check('chk_buyer_escrows_next_seq_positive', '"next_seq" >= 1')
export class BuyerEscrowEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /** CAIP-10. The buyer, and the seed of the escrow PDA. */
  @Column({ name: 'account_id', type: 'varchar', length: 256 })
  accountId: string;

  /**
   * CAIP-19. The stake mint the escrow's token account holds — a *property* of
   * the escrow, never part of its identity, because `Config` fixes exactly one
   * mint and the chain has no per-asset escrow to distinguish.
   */
  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  /**
   * CAIP-10. The on-chain thing holding this buyer's money.
   *
   * `["escrow", payer]` on Solana — a voucher's `pay_to`. On eip155 it is the
   * escrow contract's own address: one contract holds every buyer, so there is
   * nothing per-buyer to derive. Renamed from `escrow_pda` for multichain
   * support because the old name is only true on one of the two.
   */
  @Column({ name: 'escrow_account_id', type: 'varchar', length: 256 })
  escrowAccountId: string;

  /**
   * CAIP-10. Where the balance actually sits.
   *
   * `ATA(escrow, stake_mint)` on Solana; the escrow contract itself on eip155,
   * where `getVaultAccount(owner, asset)` is the identity function.
   */
  @Column({ name: 'escrow_asset_account_id', type: 'varchar', length: 256 })
  escrowAssetAccountId: string;

  /**
   * The next sequence number to issue, 1-based.
   *
   * A string because `bigint` is a `u64` and JavaScript's `number` is not. It
   * only ever increases — `trg_buyer_escrows_seq_monotonic` refuses an UPDATE
   * that lowers it, because a restore-from-backup that rewound this column
   * would re-issue live numbers silently.
   */
  @Column({ name: 'next_seq', type: 'bigint', default: 1 })
  nextSeq: string;

  /** The `open_escrow` transaction, when the platform knows it. */
  @Column({ name: 'opened_tx_ref', type: 'varchar', length: 256, nullable: true })
  openedTxRef: string | null;

  @Column({ name: 'opened_at', type: 'timestamptz', nullable: true })
  openedAt: Date | null;
}
