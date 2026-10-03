import fc from 'fast-check';

import { MONEY_MAX_ATOMIC_UNITS, MoneyUtil } from '@shared/utils/money.util';
import { AssetId } from '@modules/chains/ports/caip.types';

const USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as AssetId;

const NUM_RUNS = 500;

/**
 * A pair `[a, b]` whose sum is guaranteed to land inside the representable
 * range — including, sometimes, exactly on the upper bound. Generating two
 * independent amounts and filtering would throw away most samples and would
 * never reach the boundary.
 */
const pairSummingWithinRange = fc
  .bigInt({ min: 0n, max: MONEY_MAX_ATOMIC_UNITS })
  .chain((sum) => fc.bigInt({ min: 0n, max: sum }).map((b) => [sum - b, b] as const));

const usdc = (amount: bigint) => MoneyUtil.of(amount, USDC, 6);

describe('MoneyUtil — properties', () => {
  it('adding an amount then subtracting it returns the original', () => {
    fc.assert(
      fc.property(pairSummingWithinRange, ([a, b]) => {
        const original = usdc(a);
        const roundTripped = MoneyUtil.subtract(MoneyUtil.add(original, usdc(b)), usdc(b));
        expect(roundTripped).toEqual(original);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('subtracting an amount then adding it back returns the original', () => {
    fc.assert(
      fc.property(pairSummingWithinRange, ([a, b]) => {
        // `a + b` is in range, so `a` is a valid minuend for any `b <= a`.
        const smaller = a < b ? a : b;
        const original = usdc(a < b ? b : a);
        const roundTripped = MoneyUtil.add(
          MoneyUtil.subtract(original, usdc(smaller)),
          usdc(smaller),
        );
        expect(roundTripped).toEqual(original);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('addition is commutative', () => {
    fc.assert(
      fc.property(pairSummingWithinRange, ([a, b]) => {
        expect(MoneyUtil.add(usdc(a), usdc(b))).toEqual(MoneyUtil.add(usdc(b), usdc(a)));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('a division never invents or loses value: quotient × divisor + remainder = original', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: MONEY_MAX_ATOMIC_UNITS }),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        (amount, divisor) => {
          const original = usdc(amount);
          const { quotient, remainder } = MoneyUtil.divideWithRemainder(original, divisor);
          expect(MoneyUtil.add(MoneyUtil.multiplyByInteger(quotient, divisor), remainder)).toEqual(
            original,
          );
          expect(BigInt(remainder.amount) < divisor).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('a floored fee never exceeds the amount it is taken from', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: MONEY_MAX_ATOMIC_UNITS }),
        fc.integer({ min: 0, max: 10_000 }),
        (amount, bps) => {
          const gross = usdc(amount);
          const fee = MoneyUtil.multiplyByRate(gross, bps);
          expect(MoneyUtil.compare(fee, gross)).toBeLessThanOrEqual(0);
          // The remainder is creditable, which is what "rounds against the
          // platform" means in practice.
          expect(() => MoneyUtil.subtract(gross, fee)).not.toThrow();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
