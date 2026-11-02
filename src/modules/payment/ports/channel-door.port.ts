import { AssetId } from '@modules/chains/ports/caip.types';

import { ChannelSlot, ChannelVoucherMessage } from '../domain/channel/channel-voucher';

/**
 * The channel door of the escrow (assay-evm D-28, W1 commit 6e36571), as the
 * settlement scheduler and the reconciler need it. eip155 only. Every send goes
 * through the REDEEMER key (the only sender `settleChannels` and
 * `refundChannels` accept, and the only one that may `collectChannels` before
 * the 7-day timeout), its float and its hourly spend budget.
 */
export const CHANNEL_DOOR = 'CHANNEL_DOOR';

/** The four public inputs of a channel key. Addresses are 0x hex. */
export interface ChannelRefInput {
  readonly payer: `0x${string}`;
  readonly signer: `0x${string}`;
  readonly provider: `0x${string}`;
  readonly channelId: `0x${string}`;
}

export interface SettleItem {
  readonly voucher: ChannelVoucherMessage;
  readonly signature: `0x${string}`;
  readonly fromSettled: bigint;
  readonly charge: bigint;
}

/** Which budget lane a send is charged to (SPEC-W2 §3). */
export type SendLane = 'ORDINARY' | 'URGENT' | 'DEADLINE';

/** What one settle item did, read from the receipt (or the simulation). */
export type SettleItemOutcome =
  | {
      readonly kind: 'SETTLED';
      readonly index: number;
      readonly key: `0x${string}`;
      readonly cumulative: bigint;
      readonly calls: number;
      readonly charge: bigint;
      readonly maturityHour: number;
      readonly takeRateBps: number;
      /** `ChannelOpened` came with it: the key's first settlement. */
      readonly opened: { readonly signer: `0x${string}`; readonly channelId: `0x${string}` } | null;
      /** A `ChannelBucketDeferred` for this key in the same item: the bucket's maturity moved. */
      readonly deferred: { readonly fromHour: number; readonly toHour: number } | null;
    }
  | {
      readonly kind: 'SKIPPED';
      readonly index: number;
      readonly key: `0x${string}` | null;
      readonly cumulative: bigint;
      readonly reason: string;
    };

export interface CollectBucketPaid {
  readonly key: `0x${string}`;
  readonly provider: `0x${string}`;
  readonly maturityHour: number;
  readonly gross: bigint;
  readonly fee: bigint;
}

export interface TransferDeferredEvent {
  readonly to: `0x${string}`;
  readonly amount: bigint;
}

export interface ChannelTxResult {
  readonly txRef: string;
  /** Block timestamp of the landing (unix s). */
  readonly landedAt: number;
}

export interface SettleResult extends ChannelTxResult {
  readonly outcomes: readonly SettleItemOutcome[];
}

export interface CollectResult extends ChannelTxResult {
  readonly paid: readonly CollectBucketPaid[];
  readonly skipped: readonly { key: `0x${string}`; reason: string }[];
  readonly deferred: readonly TransferDeferredEvent[];
}

export interface RefundItem {
  readonly ref: ChannelRefInput;
  readonly maturityHour: number;
  readonly takeRateBps: number;
  readonly amount: bigint;
  /** `channelRefundPieceId(intentId, piece)`: the chain refunds one id at most once per lane. */
  readonly refundId: `0x${string}`;
}

export interface RefundResult extends ChannelTxResult {
  readonly refunded: readonly {
    key: `0x${string}`;
    payer: `0x${string}`;
    maturityHour: number;
    takeRateBps: number;
    amount: bigint;
    refundId: `0x${string}`;
  }[];
  readonly skipped: readonly {
    key: `0x${string}`;
    reason: string;
    amount: bigint;
    /** The bucket the skipped item named (absent from older readers). */
    maturityHour?: number;
    takeRateBps?: number;
  }[];
}

/** Where a channel refund with a given `refundId` landed (its `ChannelRefunded` log). */
export interface RefundLanding {
  readonly txRef: string;
  readonly blockNumber: bigint;
  /** What that refund moved (the log's `amount`). */
  readonly amount?: bigint;
}

/**
 * The sender nonces and receipt states the "dropped" verdict needs, read in
 * ONE JSON-RPC batch so they come from one node (sec-audit 2026-11-01 M-1).
 * `receipts`: `MINED`, `PENDING` (known, not mined) or `UNKNOWN`.
 */
export interface NonceAndReceipts {
  readonly nonces: ReadonlyMap<string, bigint>;
  readonly receipts: ReadonlyMap<string, 'MINED' | 'PENDING' | 'UNKNOWN'>;
}

/** `channelBooks(key, to)`. */
export interface ChannelBooks {
  readonly slot: ChannelSlot;
  readonly unpaid: bigint;
  readonly totalUnpaid: bigint;
  /** Σ every channel bucket (`Store.held`, apart from the per-call `totalHeld`). */
  readonly held: bigint;
}

/** A send not made: fees, budget or float said wait. Nothing was signed. */
export class ChannelSendDeferredError extends Error {
  constructor(readonly detail: string) {
    super(`channel send deferred: ${detail}`);
    this.name = 'ChannelSendDeferredError';
  }
}

/**
 * A send that DEFINITELY did not change the chain: refused before the
 * broadcast (a read, an estimate, the node's own admission, `beforeBroadcast`
 * failing, the relayer giving up unsent), or mined and REVERTED. The caller
 * may release what it bound and retry.
 */
export class ChannelNotSentError extends Error {
  constructor(
    readonly detail: string,
    /** The transaction mined and reverted (its hash), rather than never sent. */
    readonly revertedTx: string | null = null,
  ) {
    super(`channel send did not land: ${detail}`);
    this.name = 'ChannelNotSentError';
  }
}

/**
 * Whether `error` from a door send means "the chain did not change". Anything
 * else — a receipt timeout, a dropped connection after `sendRawTransaction`,
 * a crash — is an UNKNOWN outcome: the transaction may land, so nothing bound
 * to it may be released or sent again until it is read back from the chain
 * (review 2026-10-31 H1/H2).
 */
export function channelSendNotSent(error: unknown): boolean {
  if (error instanceof ChannelSendDeferredError || error instanceof ChannelNotSentError) {
    return true;
  }
  const tagged = error as { broadcast?: unknown; errorCode?: unknown; code?: unknown } | null;
  // `EvmSendRejectedError`: the node refused the bytes, never pooled.
  if (tagged?.broadcast === false) return true;
  // `ChainErrors.relayNotSent`: given up before anything was signed.
  return tagged?.errorCode === 'CHAIN_RELAY_NOT_SENT' || tagged?.code === 'CHAIN_RELAY_NOT_SENT';
}

/** Who signed a send and at which nonce: what decides "dropped" (see {@link ChannelDoorPort.confirmedNonce}). */
export interface ChannelTxSigned {
  readonly from: `0x${string}`;
  readonly nonce: bigint;
}

/**
 * Per-send options: `beforeBroadcast` gets the signed hash, with its sender
 * and nonce, before anything leaves. If it rejects, nothing is broadcast.
 */
export interface ChannelSendOptions {
  readonly beforeBroadcast?: (hash: `0x${string}`, signed?: ChannelTxSigned) => Promise<void>;
}

/** What the chain says about one recorded transaction hash. */
export type ChannelTxReceipt =
  | {
      readonly state: 'MINED';
      readonly success: boolean;
      readonly txRef: string;
      readonly landedAt: number;
      /** Every settle outcome in the receipt, keyed (`index` is the receipt order). */
      readonly settled: readonly SettleItemOutcome[];
      readonly collected: readonly CollectBucketPaid[];
      readonly collectSkipped: readonly { key: `0x${string}`; reason: string }[];
      readonly deferred: readonly TransferDeferredEvent[];
      readonly refunded: RefundResult['refunded'];
      readonly refundSkipped: RefundResult['skipped'];
    }
  /** Known to the node, not mined yet. */
  | { readonly state: 'PENDING' }
  /** Neither mined nor known to the node (dropped, or never broadcast). */
  | { readonly state: 'UNKNOWN' };

/**
 * What bounds a signer's vouchers on chain (v3 §5.4.3, the inputs of `D`):
 * the delegate's `validUntil`, a revoked delegate's grace end, and the end of
 * any caps hold on the payer's escrow or on this delegate (`CapsHeld.until`).
 * `null` where it does not apply. A revoked delegate whose grace end cannot be
 * found reads `revokeGraceEndsAt = now` (settle at once).
 */
export interface SignerWindow {
  readonly validUntil: number | null;
  readonly revoked: boolean;
  readonly revokeGraceEndsAt: number | null;
  readonly heldCapsEndAt: number | null;
}

/** A provider-side reason to settle its channels now (v3 §5.4.3, provider risk). */
export interface ProviderRisk {
  readonly unbonding: boolean;
  readonly slashPending: boolean;
  /** Free bonded stake below the minimum plus the margin (a raised minimum, a slash). */
  readonly nearFloor: boolean;
  readonly blocked: boolean;
}

/** A transaction that touched the channel door and was NOT sent by our redeemer (v3 §5.7). */
export interface ForeignChannelTx {
  readonly txHash: string;
  readonly from: `0x${string}`;
  readonly events: readonly string[];
  readonly blockNumber: bigint;
}

export interface ChannelDoorPort {
  /** Whether the chain's escrow has the channel door (answered `channelBooks`). */
  doorLive(asset: AssetId): Promise<boolean>;
  /** `null` when the escrow has no channel door (before the upgrade). */
  /** `blockNumber`: read the books as of that block instead of `latest`. */
  readBooks(
    asset: AssetId,
    key: `0x${string}`,
    to?: `0x${string}`,
    blockNumber?: bigint,
  ): Promise<ChannelBooks | null>;
  /** The latest block's timestamp: every channel deadline is on chain time. */
  chainNow(asset: AssetId): Promise<number>;
  /**
   * The latest block's number and timestamp from ONE read, so a later
   * `readBooks(…, blockNumber)` sees the chain exactly at that time (two
   * `latest` reads may hit nodes at different heights).
   */
  chainHead?(asset: AssetId): Promise<{ readonly number: bigint; readonly timestamp: number }>;
  collectHoldSeconds(asset: AssetId): Promise<number | null>;
  takeRateBps(asset: AssetId): Promise<number>;
  /** The Config treasury, which receives every collect's fee. */
  treasury(asset: AssetId): Promise<`0x${string}`>;
  /** The settlement asset's issuer freeze (`USDG.isFrozen`); `false` when the token has none. */
  isFrozen(asset: AssetId, account: `0x${string}`): Promise<boolean>;
  /** `eth_call` at latest: what each item would do. Nothing is sent. */
  simulateSettle(
    asset: AssetId,
    items: readonly SettleItem[],
  ): Promise<readonly SettleItemOutcome[]>;
  /**
   * Every send rejects with {@link ChannelSendDeferredError} or
   * {@link ChannelNotSentError} when the chain definitely did not change
   * ({@link channelSendNotSent}); any other rejection is an unknown outcome.
   */
  settle(
    asset: AssetId,
    items: readonly SettleItem[],
    lane: SendLane,
    options?: ChannelSendOptions,
  ): Promise<SettleResult>;
  collect(
    asset: AssetId,
    refs: readonly ChannelRefInput[],
    keep: readonly bigint[],
    lane: SendLane,
    options?: ChannelSendOptions,
  ): Promise<CollectResult>;
  refund(
    asset: AssetId,
    items: readonly RefundItem[],
    options?: ChannelSendOptions,
  ): Promise<RefundResult>;
  claimUnpaid(asset: AssetId, to: `0x${string}`): Promise<ChannelTxResult>;
  /** Reads a recorded transaction back: mined (with its channel events), pending, or unknown. */
  txReceipt(asset: AssetId, txRef: string): Promise<ChannelTxReceipt>;
  /**
   * The sender's CONFIRMED nonce (`getTransactionCount(from, 'latest')`): a
   * recorded transaction with no receipt whose nonce is below it can never
   * land — another transaction took its nonce. The only rule for "dropped".
   */
  confirmedNonce(asset: AssetId, from: `0x${string}`): Promise<bigint>;
  /** The latest block number (a refund's "dropped" verdict must hold at two blocks, F2). */
  latestBlock(asset: AssetId): Promise<bigint>;
  /**
   * The confirmed nonces of `senders` (lowercased keys) and the receipt state
   * of `hashes`, from one JSON-RPC batch where the client supports it, nonces
   * first. Optional: without it the reads are made one by one.
   */
  nonceAndReceipts?(
    asset: AssetId,
    senders: readonly `0x${string}`[],
    hashes: readonly string[],
  ): Promise<NonceAndReceipts>;
  /**
   * The `ChannelRefunded` log of lane `key` carrying `refundId` within the
   * last `maxBlocks` blocks, or `null` when none is found there.
   */
  findRefundLanding?(
    asset: AssetId,
    key: `0x${string}`,
    refundId: `0x${string}`,
    maxBlocks: bigint,
  ): Promise<RefundLanding | null>;
  signerWindow(asset: AssetId, payer: `0x${string}`, signer: `0x${string}`): Promise<SignerWindow>;
  providerRisk(asset: AssetId, provider: `0x${string}`): Promise<ProviderRisk>;
  /**
   * Channel-door logs in `[fromBlock, latest]` (at most `maxBlocks`) whose
   * transaction was sent by anyone but the redeemer. `fromBlock` null: the
   * last `maxBlocks`. Answers the block it scanned up to.
   */
  foreignChannelTxs(
    asset: AssetId,
    fromBlock: bigint | null,
    maxBlocks: bigint,
  ): Promise<{ toBlock: bigint; foreign: readonly ForeignChannelTx[] }>;
}
