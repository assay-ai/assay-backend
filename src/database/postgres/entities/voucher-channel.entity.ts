import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** A channel's lifecycle (spec P2 v3.1 §5.1). */
export enum VoucherChannelStatus {
  OPEN = 'OPEN',
  /** No new voucher: a dispute keeps money in it, or it cannot take a bucket (`CHANNEL_ROTATE`). */
  ROTATED = 'ROTATED',
  /** The signer's authority ended (revoked delegate). */
  REVOKED = 'REVOKED',
  /** A gap, a rewind or another session: no new voucher (`CHANNEL_DESYNC`). */
  DESYNC = 'DESYNC',
  /** Settled to what was accepted, idle an hour. Never reopened. */
  CLOSED = 'CLOSED',
}

/**
 * One cumulative-voucher channel: `(payer, signer, provider, channelId)` on one
 * chain, its on-chain key, the organization, agent and credential bound at open,
 * what was accepted and what the chain settled. See the migration
 * `1793404800000-channel-vouchers` for the invariants the database holds.
 *
 * Not organization-scoped: a channel is the payer ACCOUNT's on chain, and the
 * scheduler and reconciler read it across tenants. The binding columns are what
 * admission compares a voucher's session against.
 */
@Entity('voucher_channels')
export class VoucherChannelEntity {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'chain_id', type: 'varchar', length: 64 })
  chainId: string;

  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  /** CAIP-10. */
  @Column({ name: 'payer', type: 'varchar', length: 256 })
  payer: string;

  /** CAIP-10: the payer itself, or the delegate that signed. */
  @Column({ name: 'signer', type: 'varchar', length: 256 })
  signer: string;

  /** CAIP-10: the provider's payout account, the voucher's `provider`. */
  @Column({ name: 'provider_account', type: 'varchar', length: 256 })
  providerAccount: string;

  @Column({ name: 'provider_id', type: 'uuid' })
  providerId: string;

  @Column({ name: 'channel_id', type: 'char', length: 66 })
  channelId: string;

  @Column({ name: 'channel_key', type: 'char', length: 66 })
  channelKey: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  @Column({ name: 'credential_id', type: 'uuid', nullable: true })
  credentialId: string | null;

  @Column({ name: 'status', type: 'varchar', length: 12, default: VoucherChannelStatus.OPEN })
  status: VoucherChannelStatus;

  @Column({ name: 'status_reason', type: 'varchar', length: 32, nullable: true })
  statusReason: string | null;

  @Column({ name: 'last_accepted_cumulative', type: 'numeric', precision: 20, scale: 0 })
  lastAcceptedCumulative: string;

  @Column({ name: 'last_accepted_calls', type: 'int' })
  lastAcceptedCalls: number;

  @Column({ name: 'last_issued_at', type: 'bigint', nullable: true })
  lastIssuedAt: string | null;

  @Column({ name: 'settled_cumulative', type: 'numeric', precision: 20, scale: 0 })
  settledCumulative: string;

  @Column({ name: 'settled_calls', type: 'int' })
  settledCalls: number;

  /** A settlement in flight up to this cumulative; `null` when none. */
  @Column({ name: 'settling_to', type: 'numeric', precision: 20, scale: 0, nullable: true })
  settlingTo: string | null;

  @Column({ name: 'settling_since', type: 'timestamptz', nullable: true })
  settlingSince: Date | null;

  @Column({ name: 'oldest_unsettled_at', type: 'timestamptz', nullable: true })
  oldestUnsettledAt: Date | null;

  @Column({ name: 'deadline_at', type: 'timestamptz', nullable: true })
  deadlineAt: Date | null;

  @Column({ name: 'last_settled_at', type: 'timestamptz', nullable: true })
  lastSettledAt: Date | null;

  @Column({ name: 'last_collected_at', type: 'timestamptz', nullable: true })
  lastCollectedAt: Date | null;

  /** `ChannelOpened` was seen for this key (its first settlement landed). */
  @Column({ name: 'opened_on_chain', type: 'boolean', default: false })
  openedOnChain: boolean;

  /** The delegate signer's `validUntil` (unix s) as last read at admission; `null` for the payer's own key. */
  @Column({ name: 'signer_valid_until', type: 'bigint', nullable: true })
  signerValidUntil: string | null;

  /** An urgent round was asked for (reservation at 80%, debt replacement, A_cap); the scheduler clears it. */
  @Column({ name: 'urgent_requested_at', type: 'timestamptz', nullable: true })
  urgentRequestedAt: Date | null;

  @Column({ name: 'urgent_reason', type: 'varchar', length: 16, nullable: true })
  urgentReason: string | null;

  /**
   * Why the last settle of this channel did not land (a chain skip reason,
   * `PROVIDER_BLOCKED`, `PAYER_BLOCKED`, `SEND_FAILED`, …); cleared when one
   * lands. A lapse is classified by it: provider-caused → provider forfeit,
   * buyer-caused → buyer debt, anything else → voided (review 2026-10-31 H3).
   */
  @Column({ name: 'last_skip_reason', type: 'varchar', length: 32, nullable: true })
  lastSkipReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** Every voucher admitted on a channel. */
@Entity('channel_vouchers')
export class ChannelVoucherEntity {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'channel_row_id', type: 'uuid' })
  channelRowId: string;

  /** The call this voucher paid for; `null` for a debt replacement (renew). */
  @Column({ name: 'intent_id', type: 'uuid', nullable: true })
  intentId: string | null;

  @Column({ name: 'cumulative', type: 'numeric', precision: 20, scale: 0 })
  cumulative: string;

  @Column({ name: 'calls', type: 'int' })
  calls: number;

  @Column({ name: 'issued_at', type: 'bigint' })
  issuedAt: string;

  @Column({ name: 'expires_at', type: 'bigint' })
  expiresAt: string;

  @Column({ name: 'signature', type: 'varchar', length: 132 })
  signature: string;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;
}

export enum ChannelSettlementStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  LANDED = 'LANDED',
  SKIPPED = 'SKIPPED',
  DROPPED = 'DROPPED',
}

/** One settle item: what it charged and waived, where the charge sits, what left it. */
@Entity('channel_settlements')
export class ChannelSettlementEntity {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'channel_row_id', type: 'uuid' })
  channelRowId: string;

  @Column({ name: 'voucher_id', type: 'uuid' })
  voucherId: string;

  @Column({ name: 'from_settled', type: 'numeric', precision: 20, scale: 0 })
  fromSettled: string;

  @Column({ name: 'to_cumulative', type: 'numeric', precision: 20, scale: 0 })
  toCumulative: string;

  @Column({ name: 'from_calls', type: 'int' })
  fromCalls: number;

  @Column({ name: 'to_calls', type: 'int' })
  toCalls: number;

  @Column({ name: 'charge', type: 'numeric', precision: 20, scale: 0 })
  charge: string;

  @Column({ name: 'waived', type: 'numeric', precision: 20, scale: 0 })
  waived: string;

  @Column({ name: 'tx_refs', type: 'text', array: true, default: () => `'{}'` })
  txRefs: string[];

  @Column({ name: 'maturity_hour', type: 'int', nullable: true })
  maturityHour: number | null;

  @Column({ name: 'take_rate_bps', type: 'int', nullable: true })
  takeRateBps: number | null;

  @Column({ name: 'collected', type: 'numeric', precision: 20, scale: 0, default: 0 })
  collected: string;

  @Column({ name: 'refunded', type: 'numeric', precision: 20, scale: 0, default: 0 })
  refunded: string;

  @Column({ name: 'left_amount', type: 'numeric', precision: 20, scale: 0, default: 0 })
  leftAmount: string;

  @Column({ name: 'status', type: 'varchar', length: 10, default: ChannelSettlementStatus.PENDING })
  status: ChannelSettlementStatus;

  @Column({ name: 'skip_reason', type: 'varchar', length: 32, nullable: true })
  skipReason: string | null;

  @Column({ name: 'trigger', type: 'varchar', length: 16, nullable: true })
  trigger: string | null;

  /**
   * The calls this settlement charges, fixed when it is bound: landing books
   * exactly these into the hold, whatever happened to the rows meanwhile
   * (review 2026-10-31 H2/L1). The rest of the bound rows are waived.
   */
  @Column({ name: 'charged_intent_ids', type: 'uuid', array: true, default: () => `'{}'` })
  chargedIntentIds: string[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'landed_at', type: 'timestamptz', nullable: true })
  landedAt: Date | null;
}

export enum ChannelTxKind {
  COLLECT = 'COLLECT',
  REFUND = 'REFUND',
}

export enum ChannelTxStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  LANDED = 'LANDED',
  /** A refund piece landed; the call is not refunded in full yet (MF-1). Not live. */
  PARTIAL = 'PARTIAL',
  DROPPED = 'DROPPED',
}

/**
 * A collect or refund sent with the redeemer key, recorded before its
 * broadcast so its outcome is read back from the chain, never guessed
 * (review 2026-10-31 H1/H2).
 */
@Entity('channel_txs')
export class ChannelTxEntity {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'kind', type: 'varchar', length: 8 })
  kind: ChannelTxKind;

  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  /** The refunded call (REFUND only). */
  @Column({ name: 'intent_id', type: 'uuid', nullable: true })
  intentId: string | null;

  @Column({ name: 'channel_row_ids', type: 'uuid', array: true, default: () => `'{}'` })
  channelRowIds: string[];

  @Column({ name: 'amount', type: 'numeric', precision: 20, scale: 0, nullable: true })
  amount: string | null;

  /** A refund's piece (`NULL` = 0): one bucket per piece, one piece per transaction (MF-1). */
  @Column({ name: 'piece_index', type: 'integer', nullable: true })
  pieceIndex: number | null;

  @Column({ name: 'tx_refs', type: 'text', array: true, default: () => `'{}'` })
  txRefs: string[];

  @Column({ name: 'status', type: 'varchar', length: 10, default: ChannelTxStatus.PENDING })
  status: ChannelTxStatus;

  @Column({ name: 'detail', type: 'varchar', length: 64, nullable: true })
  detail: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'landed_at', type: 'timestamptz', nullable: true })
  landedAt: Date | null;
}
