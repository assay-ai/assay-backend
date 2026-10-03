import { AssetId, isAssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { MoneyErrors } from '@shared/errors/money.errors';

/**
 * The ceiling on any amount the platform will represent: `2^64 - 1`.
 *
 * This is the SPL token `u64` limit, which is the tightest bound among the
 * chains we settle on. Clamping every chain to it means an amount that survives
 * `MoneyUtil` is always settleable — the alternative is discovering at
 * settlement time that a value the ledger happily recorded cannot be moved.
 */
export const MONEY_MAX_ATOMIC_UNITS = 2n ** 64n - 1n;

/** Money is never negative. A debt is a positive amount on the other side. */
export const MONEY_MIN_ATOMIC_UNITS = 0n;

/** Well past any real asset (EVM tops out at 18, SPL at 9); a sanity bound, not a spec. */
const MAX_DECIMALS = 36;

const BASIS_POINTS = 10_000n;
const DECIMAL_INTEGER_RE = /^-?\d+$/;

export interface MoneyFormatOptions {
  /** Appended after the number, e.g. `"1.000000 USDC"`. */
  readonly symbol?: string;
}

/**
 * Every arithmetic operation on `Money` in the system.
 *
 * There is exactly one implementation of each so that the rounding rule lives
 * in exactly one place. **Rounding always floors**, which means it always falls
 * against the platform: a fee floors down, and the remainder is credited to the
 * provider. A rounding rule that quietly favours the platform is a rounding
 * rule that eventually becomes a support incident.
 *
 * Every operation range-checks its result, and every two-operand operation
 * refuses operands of different assets. Neither check is optional or skippable.
 */
export class MoneyUtil {
  /** The only constructor. Validates the amount, the asset and the scale. */
  static of(amount: string | bigint, asset: AssetId, decimals: number): Money {
    if (!isAssetId(asset)) {
      throw MoneyErrors.invalidAsset({ value: asset });
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
      throw MoneyErrors.invalidDecimals({ value: decimals, max: MAX_DECIMALS });
    }

    const atomic = MoneyUtil.toBigInt(amount);
    MoneyUtil.assertInRange(atomic, 'of');

    return { amount: atomic.toString(), asset, decimals };
  }

  static zero(asset: AssetId, decimals: number): Money {
    return MoneyUtil.of(0n, asset, decimals);
  }

  /** Atomic units as a `bigint`. The only sanctioned way out of the string form. */
  static toAtomic(money: Money): bigint {
    return MoneyUtil.toBigInt(money.amount);
  }

  static add(a: Money, b: Money): Money {
    MoneyUtil.assertSameAsset(a, b);
    return MoneyUtil.withAmount(a, MoneyUtil.toAtomic(a) + MoneyUtil.toAtomic(b), 'add');
  }

  static subtract(a: Money, b: Money): Money {
    MoneyUtil.assertSameAsset(a, b);
    return MoneyUtil.withAmount(a, MoneyUtil.toAtomic(a) - MoneyUtil.toAtomic(b), 'subtract');
  }

  /** Sum of a non-empty list. An empty list has no asset, so it is an error, not zero. */
  static sum(values: readonly Money[]): Money {
    if (values.length === 0) {
      throw MoneyErrors.assetUnknown();
    }
    return values.reduce((total, next) => MoneyUtil.add(total, next));
  }

  /** `money × bps / 10000`, floored. Basis points, so a 2.5% fee is `250`. */
  static multiplyByRate(money: Money, bps: number): Money {
    if (!Number.isInteger(bps) || bps < 0) {
      throw MoneyErrors.invalidRate({ value: bps });
    }
    const product = MoneyUtil.toAtomic(money) * BigInt(bps);
    return MoneyUtil.withAmount(money, product / BASIS_POINTS, 'multiplyByRate');
  }

  /** `money × factor`. Used to reverse a division, not to apply a rate. */
  static multiplyByInteger(money: Money, factor: number | bigint): Money {
    const multiplier = MoneyUtil.toWholeDivisorLike(factor, false);
    return MoneyUtil.withAmount(money, MoneyUtil.toAtomic(money) * multiplier, 'multiplyByInteger');
  }

  /** `money / divisor`, floored. The lost remainder is available via `divideWithRemainder`. */
  static divide(money: Money, divisor: number | bigint): Money {
    return MoneyUtil.divideWithRemainder(money, divisor).quotient;
  }

  /**
   * Floored quotient *and* the remainder, so a split can be reconciled:
   * `quotient × divisor + remainder === money`, exactly.
   */
  static divideWithRemainder(
    money: Money,
    divisor: number | bigint,
  ): { quotient: Money; remainder: Money } {
    const d = MoneyUtil.toWholeDivisorLike(divisor, true);
    const atomic = MoneyUtil.toAtomic(money);
    return {
      quotient: MoneyUtil.withAmount(money, atomic / d, 'divide'),
      remainder: MoneyUtil.withAmount(money, atomic % d, 'divide'),
    };
  }

  static compare(a: Money, b: Money): -1 | 0 | 1 {
    MoneyUtil.assertSameAsset(a, b);
    const left = MoneyUtil.toAtomic(a);
    const right = MoneyUtil.toAtomic(b);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  static equals(a: Money, b: Money): boolean {
    return MoneyUtil.compare(a, b) === 0;
  }

  static greaterThan(a: Money, b: Money): boolean {
    return MoneyUtil.compare(a, b) === 1;
  }

  static greaterThanOrEqual(a: Money, b: Money): boolean {
    return MoneyUtil.compare(a, b) >= 0;
  }

  static lessThan(a: Money, b: Money): boolean {
    return MoneyUtil.compare(a, b) === -1;
  }

  static isZero(money: Money): boolean {
    return MoneyUtil.toAtomic(money) === 0n;
  }

  /**
   * Human-readable rendering. **Display only** — the result is a decimal string
   * and feeding it back into arithmetic is the bug this class exists to stop.
   */
  static format(money: Money, options?: MoneyFormatOptions): string {
    const digits = MoneyUtil.toAtomic(money)
      .toString()
      .padStart(money.decimals + 1, '0');
    const whole = digits.slice(0, digits.length - money.decimals);
    const fraction = money.decimals === 0 ? '' : `.${digits.slice(digits.length - money.decimals)}`;
    const symbol = options?.symbol;
    return symbol ? `${whole}${fraction} ${symbol}` : `${whole}${fraction}`;
  }

  private static assertSameAsset(a: Money, b: Money): void {
    if (a.asset !== b.asset) {
      throw MoneyErrors.assetMismatch({ left: a.asset, right: b.asset });
    }
    if (a.decimals !== b.decimals) {
      throw MoneyErrors.decimalsMismatch({
        asset: a.asset,
        left: a.decimals,
        right: b.decimals,
      });
    }
  }

  private static withAmount(source: Money, atomic: bigint, operation: string): Money {
    MoneyUtil.assertInRange(atomic, operation);
    return { amount: atomic.toString(), asset: source.asset, decimals: source.decimals };
  }

  private static assertInRange(atomic: bigint, operation: string): void {
    if (atomic < MONEY_MIN_ATOMIC_UNITS) {
      throw MoneyErrors.amountUnderflow({ value: atomic.toString(), operation });
    }
    if (atomic > MONEY_MAX_ATOMIC_UNITS) {
      throw MoneyErrors.amountOverflow({
        value: atomic.toString(),
        max: MONEY_MAX_ATOMIC_UNITS.toString(),
        operation,
      });
    }
  }

  /**
   * A `number` is refused outright, even a safe-integer one. Accepting
   * `1000000` would make `1000000.5` a runtime coin-flip and would put a float
   * on the call path, which is precisely what this type forbids.
   */
  private static toBigInt(amount: string | bigint): bigint {
    if (typeof amount === 'bigint') {
      return amount;
    }
    if (typeof amount !== 'string' || !DECIMAL_INTEGER_RE.test(amount)) {
      throw MoneyErrors.amountNotAnInteger({ value: amount, type: typeof amount });
    }
    return BigInt(amount);
  }

  private static toWholeDivisorLike(value: number | bigint, rejectZero: boolean): bigint {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw MoneyErrors.invalidDivisor({ value });
    }
    const asBigInt = typeof value === 'bigint' ? value : BigInt(value);
    if (asBigInt === 0n) {
      if (rejectZero) {
        throw MoneyErrors.divisionByZero();
      }
      return asBigInt;
    }
    if (asBigInt < 0n) {
      throw MoneyErrors.invalidDivisor({ value: value.toString() });
    }
    return asBigInt;
  }
}
