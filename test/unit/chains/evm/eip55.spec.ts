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
});
