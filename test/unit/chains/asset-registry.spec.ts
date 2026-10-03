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

/**
 * USDG on Robinhood Chain, and the mainnet row that deliberately does not
 * exist.
 *
 * Every value here was measured read-only against the public RPC on 2026-09-07
 * with the pinned Foundry build and is recorded in `docs/chain-facts.md` in
 * assay-evm. The point of the suite is the asymmetry: testnet is registered because it
 * was measured, mainnet is absent because the same probe came back empty.
 */
describe('asset-registry — USDG on Robinhood Chain', () => {
  const TESTNET_USDG = '0x915Ef7c9F9f80a69e3BE47A38EE0Bb47607103ec';

  it('registers testnet USDG at the measured address, 6 dp and pegged', () => {
    const metadata = getAssetMetadata(ASSET_IDS.USDG_ROBINHOOD_TESTNET);

    expect(metadata).toEqual({
      assetId: `${CHAIN_IDS.ROBINHOOD_TESTNET}/erc20:${TESTNET_USDG}`,
      symbol: 'USDG',
      decimals: 6,
      chainId: CHAIN_IDS.ROBINHOOD_TESTNET,
      peg: 'USD-1:1',
    });
  });

  it('registers NOTHING on eip155:4663, at that address or any other', () => {
    // `cast code` at TESTNET_USDG on 4663 returned `0x` — the empty-code answer
    // — with an 11,306-byte reply from testnet as the control. The mainnet USDG
    // address is therefore unknown, and a registry entry for a token nobody has
    // read would be a guess a later reader mistakes for a measurement.
    //
    // The first assertion is the one that matters: it fails however the address
    // was chosen, so "copy the testnet address across" and "pick a plausible
    // one" are both caught.
    expect(registeredAssets().map((asset) => asset.chainId)).not.toContain(
      CHAIN_IDS.ROBINHOOD_MAINNET,
    );
    expect(
      isRegisteredAsset(`${CHAIN_IDS.ROBINHOOD_MAINNET}/erc20:${TESTNET_USDG}` as AssetId),
    ).toBe(false);
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
