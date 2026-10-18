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

export interface HeldTxResult {
  /** The transaction hash. */
  readonly txRef: string;
}

export interface HeldPaymentsPort {
  /**
   * `held(payer, seq)`. `null` when the chain has no hold at all — an escrow
   * deployment before the upgrade, or a chain without rail B. A record with
   * status `NONE` on an upgraded escrow is a voucher never redeemed.
   */
  readHeld(asset: AssetId, key: HeldKey): Promise<HeldRecord | null>;
  /** `collectHeld` (one key) or `collectHeldBatch` (up to {@link MAX_HELD_BATCH}). */
  collect(asset: AssetId, keys: readonly HeldKey[]): Promise<HeldTxResult>;
  /** `refundHeld` (one key) or `refundHeldBatch`. Redeemer only, before the timeout. */
  refund(asset: AssetId, keys: readonly HeldKey[]): Promise<HeldTxResult>;
  /** `totalHeld()`, or `null` when the escrow has no hold. */
  totalHeld(asset: AssetId): Promise<bigint | null>;
  /** `X402Config.collectHoldSeconds()`, or `null` when the config has no hold. */
  collectHoldSeconds(asset: AssetId): Promise<number | null>;
}

export const HELD_PAYMENTS = 'HELD_PAYMENTS';
