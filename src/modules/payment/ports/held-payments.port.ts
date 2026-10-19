import { AccountId, AssetId } from '@modules/chains/ports/caip.types';

/**
 * "Redeem into hold" (G3.B1, analysis §5): `redeemVoucher` no longer pays the
 * provider. It writes `held[payer][seq]` on the escrow, out of the buyer's
 * balance, and only the redeemer moves it on: `collectHeld` to the provider
 * once `collectableAt` has passed, or `refundHeld` back into the buyer's
 * escrow until `collectableAt + HELD_TIMEOUT_SECONDS` (after which anyone may
 * collect, in the provider's favour).
 *
 * This port is the backend's whole view of that, so a test can fake the chain.
 */
export enum HeldStatus {
  NONE = 'NONE',
  HELD = 'HELD',
  COLLECTED = 'COLLECTED',
  REFUNDED = 'REFUNDED',
}

/** The contract's `HELD_TIMEOUT_SECONDS`: 7 days after `collectableAt`. */
export const HELD_TIMEOUT_SECONDS = 7 * 86_400;

/** `MAX_REDEEM_BATCH`, which also bounds `collectHeldBatch` / `refundHeldBatch`. */
export const MAX_HELD_BATCH = 64;

export interface HeldKey {
  readonly payer: AccountId;
  /** The voucher's seq, decimal. */
  readonly seq: string;
}

/** `held(payer, seq)`, as the contract stores it. */
export interface HeldRecord {
  readonly status: HeldStatus;
  readonly provider: string;
  /** Minor units of the escrow's asset. */
  readonly amount: bigint;
  readonly takeRateBps: number;
  readonly collectableAt: Date;
}

/**
 * What a landed redemption did, decided from its receipt (review P0-1): a
 * `PaymentHeld` log means the payment is held; a bare `VoucherRedeemed` means
 * the escrow paid the provider at once (a redemption before the upgrade).
 * `UNKNOWN`: no receipt, or neither log — retried, never guessed.
 */
export type RedemptionClass =
  | { readonly kind: 'HELD'; readonly collectableAt: Date }
  | { readonly kind: 'PAID' }
  | { readonly kind: 'UNKNOWN' };

export interface HeldTxResult {
  /** The transaction hash. */
  readonly txRef: string;
}

export interface HeldPaymentsPort {
  /**
   * Whether the escrow hold is live on this asset's chain: listed in
   * `EVM_HOLD_LIVE_CHAINS`, OR the escrow's implementation answers the hold's
   * own view (`totalHeld()`), probed once and cached per chain — so the hold is
   * recognised the moment the upgrade lands, before the flag flips. Once it is
   * live, a redemption with no decisive receipt is retried, never paid at once.
   */
  holdLive(asset: AssetId): Promise<boolean>;
  /**
   * Classifies a landed redemption from its receipt (`txRef`, a transaction
   * hash). Without a hash it falls back to `held(payer, seq)`, which on a live
   * hold must find the record.
   */
  classifyRedemption(asset: AssetId, txRef: string | null, key: HeldKey): Promise<RedemptionClass>;
  /**
   * `held(payer, seq)`. `null` when the chain has no hold at all — an escrow
   * deployment before the upgrade, or a chain without rail B. A record with
   * status `NONE` on an upgraded escrow is a voucher never redeemed.
   */
  readHeld(asset: AssetId, key: HeldKey): Promise<HeldRecord | null>;
  /**
   * `collectHeld` (one key) or `collectHeldBatch` (up to {@link MAX_HELD_BATCH}),
   * simulated with `eth_call` first: a refusal throws before any gas is spent.
   * Both sends need the REDEEMER key: only the scheduler holds it.
   */
  collect(asset: AssetId, keys: readonly HeldKey[]): Promise<HeldTxResult>;
  /** `refundHeld` (one key) or `refundHeldBatch`. Redeemer only, before the timeout. */
  refund(asset: AssetId, keys: readonly HeldKey[]): Promise<HeldTxResult>;
  /** `totalHeld()`, or `null` when the escrow has no hold. */
  totalHeld(asset: AssetId): Promise<bigint | null>;
  /** `AssayConfig.collectHoldSeconds()`, or `null` when the config has no hold. */
  collectHoldSeconds(asset: AssetId): Promise<number | null>;
}

export const HELD_PAYMENTS = 'HELD_PAYMENTS';
