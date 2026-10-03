import { AssetId, ChainId } from './caip.types';

/**
 * Money is an integer count of an asset's smallest indivisible unit, plus the
 * identity of that asset. It is never a `number`.
 *
 * IEEE-754 doubles cannot represent every 6-decimal USDC amount exactly, and
 * they silently round instead of failing — which turns a rounding bug into a
 * reconciliation discrepancy discovered weeks later. The amount is therefore a
 * decimal *string* on the wire and in storage, and a `bigint` for exactly as
 * long as an arithmetic operation takes.
 *
 * A bare amount is also meaningless: `"10000"` is one cent of USDC, or a
 * rounding error of BONK. The asset travels with the amount, always.
 */
export interface Money {
  /** Atomic units as a decimal integer string. `"1000000"` is 1.000000 USDC. */
  readonly amount: string;
  /** CAIP-19 — which asset, on which chain. */
  readonly asset: AssetId;
  /**
   * The scale of `amount`. Display only: arithmetic never touches it, but two
   * operands presenting the same asset at different scales is data corruption
   * and `MoneyUtil` refuses it.
   */
  readonly decimals: number;
}

export interface AssetMetadata {
  readonly assetId: AssetId;
  readonly symbol: string;
  readonly decimals: number;
  readonly chainId: ChainId;
  /**
   * `'USD-1:1'` when one atomic unit of this asset is one atomic unit of the
   * platform's unit of account.
   *
   * A chain's SETTLEMENT asset must be pegged and 6 dp, asserted at
   * boot: the moment it is not, `price_amount` — USD minor units at scale 6 —
   * needs an oracle to become a chain `Money`, and an oracle is a new trusted
   * input on the paying path. `null` for anything the platform holds but does
   * not settle in.
   *
   * Not optional. A missing field would default to "unpegged" on assets that
   * are pegged, and the boot guard would refuse a correct configuration; making
   * every row answer the question is the point.
   */
  readonly peg: 'USD-1:1' | null;
}
