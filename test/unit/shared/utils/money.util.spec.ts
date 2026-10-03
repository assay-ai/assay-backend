import {
  MONEY_MAX_ATOMIC_UNITS,
  MONEY_MIN_ATOMIC_UNITS,
  MoneyUtil,
} from '@shared/utils/money.util';
import { MoneyErrorCode } from '@shared/errors/money.errors';
import { AssetId } from '@modules/chains/ports/caip.types';
import { expectErrorCode } from '../../helpers/expect-error-code';

const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC = `${SOLANA_MAINNET}/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` as AssetId;
const BONK = `${SOLANA_MAINNET}/token:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` as AssetId;

const usdc = (amount: string | bigint) => MoneyUtil.of(amount, USDC, 6);
const bonk = (amount: string | bigint) => MoneyUtil.of(amount, BONK, 5);

describe('MoneyUtil.of — atomic units only, never a float', () => {
  it('keeps the amount as the exact decimal string it was given', () => {
    expect(usdc('1000000')).toEqual({ amount: '1000000', asset: USDC, decimals: 6 });
  });

  it('accepts a bigint and normalises it to a string', () => {
    expect(usdc(1000000n).amount).toBe('1000000');
  });

  it('normalises leading zeros so equal amounts compare equal as strings', () => {
    expect(usdc('0000123').amount).toBe('123');
    expect(usdc('0').amount).toBe('0');
  });

  it.each([
    ['a decimal point', '1.5'],
    ['a trailing decimal point', '1.'],
    ['exponent notation', '1e6'],
    ['a thousands separator', '1,000'],
    ['whitespace', ' 100 '],
    ['a hex literal', '0x64'],
    ['a bare sign', '-'],
    ['the empty string', ''],
    ['a non-numeric string', 'abc'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
  ])('refuses %s', (_label, amount) => {
    expectErrorCode(() => usdc(amount), MoneyErrorCode.MONEY_AMOUNT_NOT_AN_INTEGER);
  });

  it('refuses a JavaScript number outright, even a safe integer one', () => {
    expectErrorCode(() => usdc(1000000 as never), MoneyErrorCode.MONEY_AMOUNT_NOT_AN_INTEGER);
  });

  it('refuses a float, which is the bug this type exists to prevent', () => {
    expectErrorCode(() => usdc((0.1 + 0.2) as never), MoneyErrorCode.MONEY_AMOUNT_NOT_AN_INTEGER);
  });

  it.each([
    ['negative decimals', -1],
    ['fractional decimals', 6.5],
    ['decimals beyond any real asset', 78],
  ])('refuses %s', (_label, decimals) => {
    expectErrorCode(() => MoneyUtil.of('1', USDC, decimals), MoneyErrorCode.MONEY_INVALID_DECIMALS);
  });

  it('refuses an asset that is not a CAIP-19 id', () => {
    expectErrorCode(
      () => MoneyUtil.of('1', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as AssetId, 6),
      MoneyErrorCode.MONEY_INVALID_ASSET,
    );
  });
});

describe('MoneyUtil — the boundaries', () => {
  it('accepts the upper bound exactly', () => {
    expect(usdc(MONEY_MAX_ATOMIC_UNITS).amount).toBe(MONEY_MAX_ATOMIC_UNITS.toString());
  });

  it('accepts the lower bound exactly', () => {
    expect(usdc(MONEY_MIN_ATOMIC_UNITS).amount).toBe('0');
  });

  it('refuses one unit above the upper bound at construction', () => {
    expectErrorCode(() => usdc(MONEY_MAX_ATOMIC_UNITS + 1n), MoneyErrorCode.MONEY_AMOUNT_OVERFLOW);
  });

  it('refuses one unit below the lower bound at construction', () => {
    expectErrorCode(() => usdc('-1'), MoneyErrorCode.MONEY_AMOUNT_UNDERFLOW);
  });

  it('refuses an addition that crosses the upper bound', () => {
    expectErrorCode(
      () => MoneyUtil.add(usdc(MONEY_MAX_ATOMIC_UNITS), usdc('1')),
      MoneyErrorCode.MONEY_AMOUNT_OVERFLOW,
    );
  });

  it('adds up to the upper bound without complaining', () => {
    const a = usdc(MONEY_MAX_ATOMIC_UNITS - 1n);
    expect(MoneyUtil.add(a, usdc('1')).amount).toBe(MONEY_MAX_ATOMIC_UNITS.toString());
  });

  it('refuses a subtraction that crosses the lower bound', () => {
    expectErrorCode(
      () => MoneyUtil.subtract(usdc('0'), usdc('1')),
      MoneyErrorCode.MONEY_AMOUNT_UNDERFLOW,
    );
  });

  it('subtracts down to the lower bound without complaining', () => {
    expect(MoneyUtil.subtract(usdc('1'), usdc('1')).amount).toBe('0');
  });

  it('refuses a rate multiplication that crosses the upper bound', () => {
    expectErrorCode(
      () => MoneyUtil.multiplyByRate(usdc(MONEY_MAX_ATOMIC_UNITS), 10_001),
      MoneyErrorCode.MONEY_AMOUNT_OVERFLOW,
    );
  });
});

describe('MoneyUtil — two operands must be the same asset', () => {
  it('refuses to add across assets', () => {
    expectErrorCode(() => MoneyUtil.add(usdc('1'), bonk('1')), MoneyErrorCode.MONEY_ASSET_MISMATCH);
  });

  it('refuses to subtract across assets', () => {
    expectErrorCode(
      () => MoneyUtil.subtract(usdc('10'), bonk('1')),
      MoneyErrorCode.MONEY_ASSET_MISMATCH,
    );
  });

  it('refuses to compare across assets, rather than returning a meaningless order', () => {
    expectErrorCode(
      () => MoneyUtil.compare(usdc('1'), bonk('1')),
      MoneyErrorCode.MONEY_ASSET_MISMATCH,
    );
  });

  it('refuses two operands of the same asset that disagree about decimals', () => {
    const wrongScale = { amount: '1', asset: USDC, decimals: 9 };
    expectErrorCode(
      () => MoneyUtil.add(usdc('1'), wrongScale),
      MoneyErrorCode.MONEY_DECIMALS_MISMATCH,
    );
  });
});

describe('MoneyUtil.add / subtract', () => {
  it('adds within an asset', () => {
    expect(MoneyUtil.add(usdc('1000000'), usdc('2500000'))).toEqual(usdc('3500000'));
  });

  it('subtracts within an asset', () => {
    expect(MoneyUtil.subtract(usdc('3500000'), usdc('2500000'))).toEqual(usdc('1000000'));
  });

  it('sums a list', () => {
    expect(MoneyUtil.sum([usdc('1'), usdc('2'), usdc('3')])).toEqual(usdc('6'));
  });

  it('refuses to sum an empty list, because the asset would be unknowable', () => {
    expectErrorCode(() => MoneyUtil.sum([]), MoneyErrorCode.MONEY_ASSET_UNKNOWN);
  });
});

describe('MoneyUtil.multiplyByRate — basis points, floored', () => {
  it('applies a whole-percent rate exactly', () => {
    expect(MoneyUtil.multiplyByRate(usdc('1000000'), 250).amount).toBe('25000');
  });

  it('floors rather than rounding to nearest, so the platform never over-collects', () => {
    // 1_000_001 × 250 / 10_000 = 25_000.025
    expect(MoneyUtil.multiplyByRate(usdc('1000001'), 250).amount).toBe('25000');
  });

  it('floors a value that would round up to the next unit', () => {
    // 3 × 5_000 / 10_000 = 1.5
    expect(MoneyUtil.multiplyByRate(usdc('3'), 5_000).amount).toBe('1');
  });

  it('floors a sub-unit fee to zero rather than inventing one', () => {
    expect(MoneyUtil.multiplyByRate(usdc('1'), 250).amount).toBe('0');
  });

  it('is the identity at 10000 bps', () => {
    expect(MoneyUtil.multiplyByRate(usdc('123456789'), 10_000).amount).toBe('123456789');
  });

  it('is zero at 0 bps', () => {
    expect(MoneyUtil.multiplyByRate(usdc('123456789'), 0).amount).toBe('0');
  });

  it.each([
    ['a negative rate', -1],
    ['a fractional rate', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses %s', (_label, bps) => {
    expectErrorCode(
      () => MoneyUtil.multiplyByRate(usdc('1000000'), bps),
      MoneyErrorCode.MONEY_INVALID_RATE,
    );
  });
});

describe('MoneyUtil.divide — floored, and the remainder is never lost', () => {
  it('divides exactly when it divides exactly', () => {
    expect(MoneyUtil.divide(usdc('1000000'), 4).amount).toBe('250000');
  });

  it('floors 7 / 2 to 3 rather than 3.5 or 4', () => {
    expect(MoneyUtil.divide(usdc('7'), 2).amount).toBe('3');
  });

  it('floors 999999 / 1000000 to zero rather than to one unit', () => {
    expect(MoneyUtil.divide(usdc('999999'), 1_000_000).amount).toBe('0');
  });

  it('floors rather than rounding half up at exactly .5', () => {
    expect(MoneyUtil.divide(usdc('5'), 10).amount).toBe('0');
  });

  it('accepts a bigint divisor larger than Number.MAX_SAFE_INTEGER', () => {
    expect(MoneyUtil.divide(usdc(MONEY_MAX_ATOMIC_UNITS), 2n ** 63n).amount).toBe('1');
  });

  it('reports the quotient and remainder together so a split loses nothing', () => {
    const { quotient, remainder } = MoneyUtil.divideWithRemainder(usdc('1000000'), 3);
    expect(quotient.amount).toBe('333333');
    expect(remainder.amount).toBe('1');
    expect(MoneyUtil.add(MoneyUtil.multiplyByInteger(quotient, 3), remainder)).toEqual(
      usdc('1000000'),
    );
  });

  it.each([
    ['zero', 0],
    ['a negative divisor', -2],
    ['a fractional divisor', 2.5],
    ['NaN', Number.NaN],
  ])('refuses %s', (_label, divisor) => {
    expectErrorCode(
      () => MoneyUtil.divide(usdc('1000000'), divisor),
      divisor === 0 ? MoneyErrorCode.MONEY_DIVISION_BY_ZERO : MoneyErrorCode.MONEY_INVALID_DIVISOR,
    );
  });
});

describe('MoneyUtil.compare / isZero / isNegative-free ordering', () => {
  it('orders by atomic amount', () => {
    expect(MoneyUtil.compare(usdc('1'), usdc('2'))).toBe(-1);
    expect(MoneyUtil.compare(usdc('2'), usdc('2'))).toBe(0);
    expect(MoneyUtil.compare(usdc('3'), usdc('2'))).toBe(1);
  });

  it('compares by value, not by string, so 9 is less than 10', () => {
    expect(MoneyUtil.compare(usdc('9'), usdc('10'))).toBe(-1);
  });

  it('recognises zero', () => {
    expect(MoneyUtil.isZero(usdc('0'))).toBe(true);
    expect(MoneyUtil.isZero(usdc('1'))).toBe(false);
  });

  it('exposes greaterThan / greaterThanOrEqual for the stake gate', () => {
    expect(MoneyUtil.greaterThan(usdc('2'), usdc('1'))).toBe(true);
    expect(MoneyUtil.greaterThanOrEqual(usdc('1'), usdc('1'))).toBe(true);
    expect(MoneyUtil.greaterThanOrEqual(usdc('0'), usdc('1'))).toBe(false);
  });
});

describe('MoneyUtil.format — display only', () => {
  it('places the decimal point at the asset scale', () => {
    expect(MoneyUtil.format(usdc('1000000'))).toBe('1.000000');
  });

  it('pads a sub-unit amount with leading zeros', () => {
    expect(MoneyUtil.format(usdc('1'))).toBe('0.000001');
  });

  it('formats zero at full scale', () => {
    expect(MoneyUtil.format(usdc('0'))).toBe('0.000000');
  });

  it('omits the point entirely for a zero-decimal asset', () => {
    const points = MoneyUtil.of('5', USDC, 0);
    expect(MoneyUtil.format(points)).toBe('5');
  });

  it('formats the upper bound without losing a digit to floating point', () => {
    expect(MoneyUtil.format(usdc(MONEY_MAX_ATOMIC_UNITS))).toBe('18446744073709.551615');
  });

  it('appends a symbol when one is supplied', () => {
    expect(MoneyUtil.format(usdc('2500000'), { symbol: 'USDC' })).toBe('2.500000 USDC');
  });
});
