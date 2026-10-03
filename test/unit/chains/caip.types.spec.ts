import {
  CHAIN_IDS,
  ChainNamespace,
  isAccountId,
  isAssetId,
  isChainId,
  parseAccountId,
  parseAssetId,
  parseChainId,
  toAccountId,
  toAssetId,
  toChainId,
} from '@modules/chains/ports/caip.types';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { expectErrorCode } from '../helpers/expect-error-code';

const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_MAINNET = `${SOLANA_MAINNET}/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`;
const VAULT = `${SOLANA_MAINNET}:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`;

describe('CAIP-2 — parseChainId', () => {
  it('splits a chain id into namespace and reference', () => {
    expect(parseChainId(SOLANA_MAINNET)).toEqual({
      namespace: 'solana',
      reference: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    });
  });

  it('parses an eip155 chain id, so the grammar is not Solana-specific', () => {
    expect(parseChainId('eip155:8453')).toEqual({ namespace: 'eip155', reference: '8453' });
  });

  it.each([
    ['no separator', 'solana'],
    ['empty reference', 'solana:'],
    ['empty namespace', ':5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
    ['uppercase namespace', 'SOLANA:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
    ['namespace too short', 'so:8453'],
    ['namespace too long', 'aneedlesslylong:8453'],
    ['reference too long', `solana:${'a'.repeat(33)}`],
    ['an account id, which is not a chain id', VAULT],
    ['an asset id, which is not a chain id', USDC_MAINNET],
    ['leading whitespace', ' eip155:8453'],
    ['empty string', ''],
  ])('rejects %s', (_label, value) => {
    expectErrorCode(() => parseChainId(value), ChainErrorCode.CHAIN_INVALID_CHAIN_ID);
  });

  it('isChainId answers without throwing', () => {
    expect(isChainId(SOLANA_MAINNET)).toBe(true);
    expect(isChainId('solana')).toBe(false);
  });
});

describe('CAIP-19 — parseAssetId', () => {
  it('splits an asset id into chain, asset namespace and asset reference', () => {
    expect(parseAssetId(USDC_MAINNET)).toEqual({
      chainId: SOLANA_MAINNET,
      assetNamespace: 'token',
      assetReference: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    });
  });

  it('parses an erc20 asset id', () => {
    expect(parseAssetId('eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toEqual({
      chainId: 'eip155:8453',
      assetNamespace: 'erc20',
      assetReference: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
  });

  it.each([
    ['a bare mint address with no chain', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
    ['a chain id with no asset', SOLANA_MAINNET],
    ['a missing asset reference', `${SOLANA_MAINNET}/token:`],
    ['a missing asset namespace', `${SOLANA_MAINNET}/:EPjFWdd5Aufq`],
    ['an uppercase asset namespace', `${SOLANA_MAINNET}/TOKEN:EPjFWdd5Aufq`],
    ['a malformed chain part', `solana/token:EPjFWdd5Aufq`],
    ['two asset separators', `${SOLANA_MAINNET}/token:a/token:b`],
    ['an asset reference over 128 characters', `${SOLANA_MAINNET}/token:${'a'.repeat(129)}`],
    ['empty string', ''],
  ])('rejects %s', (_label, value) => {
    expectErrorCode(() => parseAssetId(value), ChainErrorCode.CHAIN_INVALID_ASSET_ID);
  });

  it('isAssetId answers without throwing', () => {
    expect(isAssetId(USDC_MAINNET)).toBe(true);
    expect(isAssetId(SOLANA_MAINNET)).toBe(false);
  });
});

describe('CAIP-10 — parseAccountId', () => {
  it('splits an account id into chain and address', () => {
    expect(parseAccountId(VAULT)).toEqual({
      chainId: SOLANA_MAINNET,
      address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    });
  });

  it.each([
    ['a bare address with no chain', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'],
    ['a chain id with no address', SOLANA_MAINNET],
    ['an empty address', `${SOLANA_MAINNET}:`],
    ['an asset id, which is not an account id', USDC_MAINNET],
    ['an address over 128 characters', `${SOLANA_MAINNET}:${'a'.repeat(129)}`],
    ['empty string', ''],
  ])('rejects %s', (_label, value) => {
    expectErrorCode(() => parseAccountId(value), ChainErrorCode.CHAIN_INVALID_ACCOUNT_ID);
  });

  it('isAccountId answers without throwing', () => {
    expect(isAccountId(VAULT)).toBe(true);
    expect(isAccountId(USDC_MAINNET)).toBe(false);
  });
});

describe('CAIP constructors round-trip their parsers', () => {
  it('toChainId', () => {
    const chainId = toChainId(ChainNamespace.SOLANA, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(chainId).toBe(SOLANA_MAINNET);
    expect(parseChainId(chainId).namespace).toBe('solana');
  });

  it('toAccountId', () => {
    const accountId = toAccountId(
      CHAIN_IDS.SOLANA_MAINNET,
      '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    );
    expect(accountId).toBe(VAULT);
    expect(parseAccountId(accountId).chainId).toBe(CHAIN_IDS.SOLANA_MAINNET);
  });

  it('toAssetId', () => {
    const assetId = toAssetId(
      CHAIN_IDS.SOLANA_MAINNET,
      'token',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    expect(assetId).toBe(USDC_MAINNET);
    expect(parseAssetId(assetId).chainId).toBe(CHAIN_IDS.SOLANA_MAINNET);
  });

  it('refuses to build an account id on a malformed chain', () => {
    expectErrorCode(
      () => toAccountId('solana' as never, '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'),
      ChainErrorCode.CHAIN_INVALID_CHAIN_ID,
    );
  });

  it('refuses to build an account id from a malformed address', () => {
    expectErrorCode(
      () => toAccountId(CHAIN_IDS.SOLANA_MAINNET, 'has spaces'),
      ChainErrorCode.CHAIN_INVALID_ACCOUNT_ID,
    );
  });
});

describe('CHAIN_IDS', () => {
  it('every declared chain id parses', () => {
    for (const chainId of Object.values(CHAIN_IDS)) {
      expect(() => parseChainId(chainId)).not.toThrow();
    }
  });

  it('names a namespace that exists in ChainNamespace', () => {
    const namespaces = new Set<string>(Object.values(ChainNamespace));
    for (const chainId of Object.values(CHAIN_IDS)) {
      expect(namespaces.has(parseChainId(chainId).namespace)).toBe(true);
    }
  });
});
