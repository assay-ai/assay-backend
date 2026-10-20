import { formatDollars } from '@shared/utils/money-display.util';

const usd = (amount: string) => ({ amount, decimals: 6 });

describe('formatDollars', () => {
  it('writes two decimals, truncated', () => {
    expect(formatDollars(usd('119955000'))).toBe('$119.95');
    expect(formatDollars(usd('100000000'))).toBe('$100.00');
    expect(formatDollars(usd('1234567890000'))).toBe('$1,234,567.89');
  });

  it('keeps up to three decimals under $0.10, as the penalty pages do', () => {
    expect(formatDollars(usd('40000'))).toBe('$0.04');
    expect(formatDollars(usd('36000'))).toBe('$0.036');
    expect(formatDollars(usd('9999'))).toBe('$0.009');
    expect(formatDollars(usd('100000'))).toBe('$0.10');
  });

  it('writes a native coin as units, never with a dollar sign', () => {
    expect(
      formatDollars({
        amount: '1500000000',
        decimals: 9,
        asset: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/slip44:501',
      }),
    ).toBe('1.5 units');
    expect(
      formatDollars({ amount: '40000', decimals: 6, asset: 'eip155:46630/erc20:0xDbbC' }),
    ).toBe('$0.04');
  });

  it('never writes a non-zero amount as zero', () => {
    expect(formatDollars(usd('1'))).toBe('$0.000001');
    expect(formatDollars(usd('0'))).toBe('$0.00');
  });
});
