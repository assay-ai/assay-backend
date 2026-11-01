import { accountSpellings } from '@database/postgres/repositories/voucher-channel.repository';

/** Final review 2026-11-01 F3: the indexable spelling set the payer lookups match. */
describe('accountSpellings', () => {
  it('lists the given, checksummed, lower and upper spellings of an eip155 account', () => {
    const lower = 'eip155:46630:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
    const spellings = accountSpellings(lower);
    expect(spellings).toEqual(
      expect.arrayContaining([
        lower,
        'eip155:46630:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
        'eip155:46630:0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED',
      ]),
    );
    expect(new Set(spellings).size).toBe(spellings.length);
  });

  it('matches anything else exactly (Solana base58 is case-sensitive)', () => {
    const solana =
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    expect(accountSpellings(solana)).toEqual([solana]);
    expect(accountSpellings('eip155:1:0x12')).toEqual(['eip155:1:0x12']);
  });
});
