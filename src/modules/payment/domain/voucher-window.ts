import { VOUCHER_WINDOW_SECONDS } from '../constants/voucher.constants';

/**
 * A rolling spend window's counter, decayed to `nowSeconds` — the chain's own
 * rule (`Window.decay` in assay-evm, `state.rs::decay_window` in the Anchor
 * program), chain neutral so the escrow's own limits can be pre-checked on
 * either chain.
 *
 * It drains linearly over the window and rounds UP, so capacity comes back late
 * and never early; a clock that did not advance returns nothing, and a whole
 * window elapsed drains everything.
 */
export function decayVoucherWindow(
  spentInWindow: bigint,
  windowStartedAt: number,
  nowSeconds: number,
  windowSeconds: number = VOUCHER_WINDOW_SECONDS,
): bigint {
  if (spentInWindow === 0n) return 0n;
  if (nowSeconds <= windowStartedAt) return spentInWindow;
  const window = BigInt(windowSeconds);
  const elapsed = BigInt(nowSeconds - windowStartedAt);
  if (elapsed >= window) return 0n;
  return (spentInWindow * (window - elapsed) + window - 1n) / window;
}
