import { Money } from '@modules/chains/ports/money.types';

/**
 * Money in the words a person reads in a notice: `$119.95`, `$0.036`.
 *
 * The console's display rule, so a notice and the page it links to quote the
 * same figure:
 *
 * - two decimals, truncated, never rounded up (`$119.955` is `$119.95`);
 * - under $0.10, up to three decimals (`$0.036`, `$0.04`), the penalty rule;
 * - a non-zero amount never reads as zero: below that precision it is written
 *   out to its own (`$0.000001`).
 *
 * Display only, like `MoneyUtil.format`. The platform settles in dollar
 * stablecoins, so the symbol is `$` for every asset today.
 */
export function formatDollars(
  money: Pick<Money, 'amount' | 'decimals'> & { readonly asset?: string },
): string {
  const decimals = money.decimals;
  // A chain's native coin (CAIP-19 `slip44`) is never a dollar. Every token the
  // platform settles in is a dollar stablecoin; anything else is written as
  // plain units rather than with a "$" it has not earned.
  if (money.asset && /\/slip44:/.test(money.asset)) {
    return `${plainUnits(BigInt(money.amount || '0'), decimals)} units`;
  }
  const atomic = BigInt(money.amount || '0');
  const negative = atomic < 0n;
  const value = negative ? -atomic : atomic;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = decimals === 0 ? '' : (value % scale).toString().padStart(decimals, '0');

  const minPlaces = Math.min(2, decimals);
  const small = value * 10n < scale;
  let kept = fraction.slice(0, Math.min(decimals, small ? 3 : 2));
  if (value > 0n && whole === 0n && /^0*$/.test(kept)) {
    kept = fraction;
  }
  kept = kept.replace(/0+$/, '');
  if (kept.length < minPlaces) kept = kept.padEnd(minPlaces, '0');

  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}${kept ? `.${kept}` : ''}`;
}

function plainUnits(atomic: bigint, decimals: number): string {
  const negative = atomic < 0n;
  const value = negative ? -atomic : atomic;
  const scale = 10n ** BigInt(decimals);
  const fraction =
    decimals === 0 ? '' : (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${value / scale}${fraction ? `.${fraction}` : ''}`;
}
