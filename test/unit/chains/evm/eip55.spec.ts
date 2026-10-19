import { getAddress } from 'viem';

import {
  checksummedAccount,
  checksummedAsset,
  sameAccountSpelling,
  sameAssetSpelling,
} from '@modules/chains/evm/eip55';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';

const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;
const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
const ADDRESS = '0x8ba1f109551bd432803012645ac136ddd64dba72';

describe('EIP-55 spellings of eip155 identifiers', () => {
  it('checksums an eip155 account and an erc20 asset, keeping the namespace', () => {
    expect(checksummedAccount(`${EVM}:${ADDRESS}`)).toBe(`${EVM}:${getAddress(ADDRESS)}`);
    expect(checksummedAsset(`${EVM}/erc20:${ADDRESS}`)).toBe(`${EVM}/erc20:${getAddress(ADDRESS)}`);
  });

  it('leaves Solana and malformed values unchanged', () => {
    const solana = `${SOLANA}:Agent1111111111111111111111111111111111111`;
    expect(checksummedAccount(solana)).toBe(solana);
    expect(checksummedAccount(`${EVM}:0x1234`)).toBe(`${EVM}:0x1234`);
    expect(checksummedAccount('not-an-account')).toBe('not-an-account');
    expect(checksummedAsset(`${SOLANA}/token:Mint111`)).toBe(`${SOLANA}/token:Mint111`);
  });

  it('compares eip155 spellings of one address as one, and nothing else', () => {
    expect(sameAccountSpelling(`${EVM}:${ADDRESS}`, `${EVM}:${getAddress(ADDRESS)}`)).toBe(true);
    expect(sameAccountSpelling(`${EVM}:${ADDRESS}`, `${EVM}:0x${'1'.repeat(40)}`)).toBe(false);
    expect(sameAccountSpelling(`${EVM}:${ADDRESS}`, `eip155:1:${ADDRESS}`)).toBe(false);
    expect(
      sameAssetSpelling(`${EVM}/erc20:${ADDRESS}`, `${EVM}/erc20:${getAddress(ADDRESS)}`),
    ).toBe(true);
  });

  it('keeps Solana addresses case-sensitive', () => {
    const a = `${SOLANA}:Agent1111111111111111111111111111111111111`;
    expect(sameAccountSpelling(a, a.toLowerCase())).toBe(false);
  });

  /** Review I1: only two well-formed eip155 addresses compare by their bytes. */
  describe('malformed values compare exactly, never by case', () => {
    const pairs: [string, string, string][] = [
      ['short', `${EVM}:0xABC`, `${EVM}:0xabc`],
      ['long', `${EVM}:0x${'AB'.repeat(21)}`, `${EVM}:0x${'ab'.repeat(21)}`],
      ['non-hex, 40 characters', `${EVM}:0x${'GZ'.repeat(20)}`, `${EVM}:0x${'gz'.repeat(20)}`],
      ['0X prefix', `${EVM}:0X${ADDRESS.slice(2)}`, `${EVM}:${ADDRESS}`],
      [
        '0X prefix on both',
        `${EVM}:0X${ADDRESS.slice(2).toUpperCase()}`,
        `${EVM}:0X${ADDRESS.slice(2)}`,
      ],
      ['upper-case namespace', `EIP155:46630:${ADDRESS}`, `eip155:46630:${ADDRESS}`],
    ];
    it.each(pairs)('%s: not the same account', (_label, a, b) => {
      expect(sameAccountSpelling(a, b)).toBe(false);
      expect(sameAccountSpelling(b, a)).toBe(false);
    });

    it('a near miss: one nibble apart is another account', () => {
      const near = `0x${ADDRESS.slice(2, -1)}${ADDRESS.endsWith('2') ? '3' : '2'}`;
      expect(sameAccountSpelling(`${EVM}:${ADDRESS}`, `${EVM}:${getAddress(near)}`)).toBe(false);
      expect(sameAssetSpelling(`${EVM}/erc20:${ADDRESS}`, `${EVM}/erc20:${near}`)).toBe(false);
    });

    it('a mixed-case spelling matches the stored lower-case value', () => {
      expect(sameAccountSpelling(`${EVM}:${getAddress(ADDRESS)}`, `${EVM}:${ADDRESS}`)).toBe(true);
      expect(
        sameAccountSpelling(
          `${EVM}:${ADDRESS.toUpperCase().replace('0X', '0x')}`,
          `${EVM}:${ADDRESS}`,
        ),
      ).toBe(true);
    });

    it('assets: the namespace is exact and the reference must be an address', () => {
      expect(sameAssetSpelling(`${EVM}/ERC20:${ADDRESS}`, `${EVM}/erc20:${ADDRESS}`)).toBe(false);
      expect(sameAssetSpelling(`${EVM}/erc20:0XABC`, `${EVM}/erc20:0xabc`)).toBe(false);
      expect(
        sameAssetSpelling(`${EVM}/erc20:0X${ADDRESS.slice(2)}`, `${EVM}/erc20:${ADDRESS}`),
      ).toBe(false);
      expect(sameAssetSpelling(`${EVM}/erc20:${ADDRESS}`, `eip155:1/erc20:${ADDRESS}`)).toBe(false);
    });

    it('checksumming leaves a malformed address as it was', () => {
      expect(checksummedAccount(`${EVM}:0X${ADDRESS.slice(2)}`)).toBe(
        `${EVM}:0X${ADDRESS.slice(2)}`,
      );
    });
  });
});
