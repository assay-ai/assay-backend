import { parseFaucetArgs } from '../../../scripts/devnet/lib/faucet-args';

const KEY = '6dauQmUxQCWRyDtQyczEk4rkmtjHEdh9kP82x8B6zeD4';

describe('parseFaucetArgs', () => {
  it('reads a recipient and a target balance in whole tokens', () => {
    expect(parseFaucetArgs([KEY, '100'])).toEqual({ recipient: KEY, targetAtomic: 100_000_000n });
  });

  it('defaults the target when only a recipient is given', () => {
    expect(parseFaucetArgs([KEY]).targetAtomic).toBe(100_000_000n);
  });

  it('keeps six decimals of precision', () => {
    expect(parseFaucetArgs([KEY, '0.000001']).targetAtomic).toBe(1n);
  });

  it('refuses an amount finer than one atomic unit', () => {
    expect(() => parseFaucetArgs([KEY, '0.0000001'])).toThrow(/atomic|decimal/i);
  });

  it('refuses a missing recipient', () => {
    expect(() => parseFaucetArgs([])).toThrow(/recipient/i);
  });

  it('refuses a recipient that is not base58', () => {
    expect(() => parseFaucetArgs(['not-a-key!', '10'])).toThrow(/base58/i);
  });
});
