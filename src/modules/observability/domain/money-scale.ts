/**
 * Atomic-integer money, rendered down to a `number` for a Prometheus gauge.
 *
 * Every ledger amount in this codebase is a `bigint`/numeric-string atomic
 * integer, on purpose — see `MoneyUtil`'s own docstring on why float money is
 * a bug generator. A metrics gauge is the one place that rule is deliberately
 * relaxed: Prometheus's wire format has no integer type, every sample is an
 * IEEE-754 double, and a dashboard tile reading "$128,403.55" is more useful
 * to an on-call human than one more decimal of precision they cannot act on.
 *
 * `Number.MAX_SAFE_INTEGER` is `2^53 - 1` — about 9.4 * 10^15 atomic USDC
 * units, or roughly $9.4 billion once shifted down by 6 decimals. Nothing in
 * this platform's MVP vault should ever approach that, so the precision loss
 * this function accepts is theoretical today. It is still a real loss, which
 * is exactly why this conversion may only ever happen here, at the metrics
 * boundary, and never anywhere near a ledger write or a settlement decision.
 */
export function atomicToDisplayNumber(atomic: bigint | string, decimals: number): number {
  const value = typeof atomic === 'bigint' ? atomic : BigInt(atomic);
  const scale = 10 ** decimals;
  // `Number(bigint)` first, then divide — dividing two bigints would floor to
  // an integer and throw away the fractional part a dashboard needs.
  return Number(value) / scale;
}
