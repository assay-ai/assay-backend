import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import {
  ASSET_IDS,
  getAssetMetadata,
  isRegisteredAsset,
  registeredAssets,
} from '@modules/chains/ports/asset-registry';
import { AssetId, CHAIN_IDS } from '@modules/chains/ports/caip.types';

/**
 * `SOLANA_DEVNET_USDC_MINT` is read once, at module load — see the
 * file header of `asset-registry.ts` for why. Every test here therefore
 * resets the module registry and re-imports the module with a fresh
 * `process.env`, rather than asserting on the already-loaded singleton.
 *
 * `jest.resetModules()` + a dynamic `import()` rather than
 * `jest.isolateModules()` + `require()`: the latter needs a synchronous
 * callback, which forces a CommonJS `require()` that this repo's lint config
 * (`@typescript-eslint/no-require-imports`) refuses everywhere else.
 */
describe('asset-registry — SOLANA_DEVNET_USDC_MINT override', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  async function reimport(): Promise<typeof import('@modules/chains/ports/asset-registry')> {
    jest.resetModules();
    return import('@modules/chains/ports/asset-registry');
  }

  it('defaults to Circle devnet USDC when unset', async () => {
    delete process.env.SOLANA_DEVNET_USDC_MINT;
    delete process.env.NODE_ENV;

    const { ASSET_IDS } = await reimport();

    expect(ASSET_IDS.USDC_SOLANA_DEVNET).toContain('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  });

  it('uses the override mint outside production', async () => {
    process.env.SOLANA_DEVNET_USDC_MINT = 'FakeDevnetUsdcMintAddressForTesting11111111';
    process.env.NODE_ENV = 'development';

    const { ASSET_IDS } = await reimport();

    expect(ASSET_IDS.USDC_SOLANA_DEVNET).toContain('FakeDevnetUsdcMintAddressForTesting11111111');
  });

  it('never overrides mainnet USDC, whatever the override says', async () => {
    process.env.SOLANA_DEVNET_USDC_MINT = 'FakeDevnetUsdcMintAddressForTesting11111111';
    process.env.NODE_ENV = 'development';

    const { ASSET_IDS } = await reimport();

    expect(ASSET_IDS.USDC_SOLANA_MAINNET).toContain('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('refuses to boot with the override set under NODE_ENV=production', async () => {
    process.env.SOLANA_DEVNET_USDC_MINT = 'FakeDevnetUsdcMintAddressForTesting11111111';
    process.env.NODE_ENV = 'production';

    let thrown: unknown;
    try {
      await reimport();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { errorCode?: string }).errorCode).toBe(
      ChainErrorCode.CHAIN_DEVNET_OVERRIDE_FORBIDDEN,
    );
  });

  it('boots fine under NODE_ENV=production when the override is unset', async () => {
    delete process.env.SOLANA_DEVNET_USDC_MINT;
    process.env.NODE_ENV = 'production';

    await expect(reimport()).resolves.toBeDefined();
  });
});

describe('asset-registry — ROBINHOOD_TESTNET_USDG_ADDRESS', () => {
  const ORIGINAL_ENV = { ...process.env };
  const TOKEN = '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac';

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  async function reimport(): Promise<{
    registry: typeof import('@modules/chains/ports/asset-registry');
    metadata: typeof import('@modules/chains/chain-metadata');
  }> {
    jest.resetModules();
    return {
      registry: await import('@modules/chains/ports/asset-registry'),
      metadata: await import('@modules/chains/chain-metadata'),
    };
  }

  it('registers no testnet token and refuses to boot eip155:46630 when unset', async () => {
    delete process.env.ROBINHOOD_TESTNET_USDG_ADDRESS;

    const { registry, metadata } = await reimport();

    expect(registry.ASSET_IDS.USDG_ROBINHOOD_TESTNET).toBeNull();
    expect(registry.settlementAssetsOn(CHAIN_IDS.ROBINHOOD_TESTNET)).toEqual([]);
    expect(() => metadata.assertChainMetadata([CHAIN_IDS.ROBINHOOD_TESTNET])).toThrow(
      /ROBINHOOD_TESTNET_USDG_ADDRESS/,
    );
    expect(() => metadata.assertChainMetadata([CHAIN_IDS.SOLANA_DEVNET])).not.toThrow();
  });

  it('registers the configured token and boots eip155:46630 when set', async () => {
    process.env.ROBINHOOD_TESTNET_USDG_ADDRESS = TOKEN;

    const { registry, metadata } = await reimport();

    expect(registry.ASSET_IDS.USDG_ROBINHOOD_TESTNET).toBe(
      `${CHAIN_IDS.ROBINHOOD_TESTNET}/erc20:${TOKEN}`,
    );
    expect(() => metadata.assertChainMetadata([CHAIN_IDS.ROBINHOOD_TESTNET])).not.toThrow();
  });

  it('refuses a value that is not a 20-byte address', async () => {
    process.env.ROBINHOOD_TESTNET_USDG_ADDRESS = '0x1234';

    let thrown: unknown;
    try {
      await reimport();
    } catch (error) {
      thrown = error;
    }

    expect((thrown as { errorCode?: string }).errorCode).toBe(
      ChainErrorCode.CHAIN_CONFIG_VALUE_INVALID,
    );
  });
});

/**
 * USDG on Robinhood Chain. The testnet address is the fixture
 * `test/setup-env.ts` pins; the mainnet address is a constant.
 */
describe('asset-registry — USDG on Robinhood Chain', () => {
  const TESTNET_USDG = '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac';

  it('registers testnet USDG at the configured address, 6 dp and pegged', () => {
    const metadata = getAssetMetadata(ASSET_IDS.USDG_ROBINHOOD_TESTNET);

    expect(metadata).toEqual({
      assetId: `${CHAIN_IDS.ROBINHOOD_TESTNET}/erc20:${TESTNET_USDG}`,
      symbol: 'USDG',
      decimals: 6,
      chainId: CHAIN_IDS.ROBINHOOD_TESTNET,
      peg: 'USD-1:1',
    });
  });

  it('registers mainnet USDG as a constant, 6 dp and pegged', () => {
    const MAINNET_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

    expect(getAssetMetadata(ASSET_IDS.USDG_ROBINHOOD_MAINNET)).toEqual({
      assetId: `${CHAIN_IDS.ROBINHOOD_MAINNET}/erc20:${MAINNET_USDG}`,
      symbol: 'USDG',
      decimals: 6,
      chainId: CHAIN_IDS.ROBINHOOD_MAINNET,
      peg: 'USD-1:1',
    });
    expect(
      registeredAssets().filter((asset) => asset.chainId === CHAIN_IDS.ROBINHOOD_MAINNET),
    ).toHaveLength(1);
    // Asset ids are exact strings: another spelling of the address is not it,
    // and the testnet address on 4663 is not it either.
    expect(
      isRegisteredAsset(
        `${CHAIN_IDS.ROBINHOOD_MAINNET}/erc20:${MAINNET_USDG.toLowerCase()}` as AssetId,
      ),
    ).toBe(false);
    expect(
      isRegisteredAsset(`${CHAIN_IDS.ROBINHOOD_MAINNET}/erc20:${TESTNET_USDG}` as AssetId),
    ).toBe(false);
  });

  it('keeps mainnet USDG registered when the testnet variable is unset', async () => {
    const original = { ...process.env };
    delete process.env.ROBINHOOD_TESTNET_USDG_ADDRESS;
    try {
      jest.resetModules();
      const registry = await import('@modules/chains/ports/asset-registry');
      const metadata = await import('@modules/chains/chain-metadata');
      expect(registry.isRegisteredAsset(registry.ASSET_IDS.USDG_ROBINHOOD_MAINNET)).toBe(true);
      expect(() => metadata.assertChainMetadata([CHAIN_IDS.ROBINHOOD_MAINNET])).not.toThrow();
    } finally {
      process.env = original;
    }
  });

  it('every registered asset answers the peg question, and every one is 6 dp today', () => {
    // `peg` is not optional, so this cannot be satisfied by omission. The
    // positive control for the boot guard in `chain-metadata.ts`: if a row ever
    // arrives unpegged or at another scale, that guard is what refuses the
    // chain, and this is where the change becomes visible.
    for (const asset of registeredAssets()) {
      expect({ assetId: asset.assetId, peg: asset.peg, decimals: asset.decimals }).toEqual({
        assetId: asset.assetId,
        peg: 'USD-1:1',
        decimals: 6,
      });
    }
  });
});
