import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AssetId, parseAccountId } from '@modules/chains/ports/caip.types';
import { MoneyUtil } from '@shared/utils/money.util';

/** How many trailing characters of a payment key's address a notice shows. */
export const PAYMENT_KEY_ENDING_LENGTH = 8;

/**
 * The last eight characters of a payment key's address, as the enable-paid
 * page and `assay-mcp` show its fingerprint ("ends with 1A2B9F3C", spec §7.11
 * F4): hex upper-cased, anything else as it is. Never the full address — a
 * notice names the key the way the person already saw it, and nothing more.
 */
export function paymentKeyEnding(account: string): string {
  let address = account;
  try {
    address = parseAccountId(account).address;
  } catch {
    // Not CAIP-10: use the value as given.
  }
  const hex = /^0x[0-9a-fA-F]+$/.test(address);
  const tail = (hex ? address.slice(2) : address).slice(-PAYMENT_KEY_ENDING_LENGTH);
  return hex ? tail.toUpperCase() : tail;
}

/**
 * An exact amount for a notice body: `0.120000 USDG`. Atomic units in, a
 * decimal string out, no floating point anywhere; an asset the registry does
 * not know is written with its own decimals and no symbol.
 */
export function formatPaymentKeyAmount(
  atomic: bigint | string,
  asset: string,
  decimals: number,
): string {
  try {
    const { symbol } = getAssetMetadata(asset as AssetId);
    return MoneyUtil.format(MoneyUtil.of(atomic, asset as AssetId, decimals), { symbol });
  } catch {
    try {
      return MoneyUtil.format(MoneyUtil.of(atomic, asset as AssetId, decimals));
    } catch {
      return `${atomic.toString()} atomic units`;
    }
  }
}
