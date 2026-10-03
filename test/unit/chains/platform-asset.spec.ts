import { ConfigService } from '@nestjs/config';

import { platformAssetFrom } from '@modules/chains/platform-asset';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';

const config = (values: Record<string, string | undefined> = {}) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

/**
 * The one asset a deployment prices, stakes and settles in, when
 * `PLATFORM_STAKE_ASSET_ID` does not say.
 *
 * Four call sites each defaulted to devnet USDC on their own. On a deployment that
 * runs `ENABLED_CHAINS=eip155:46630` and sets no `PLATFORM_STAKE_ASSET_ID` —
 * that put a Solana row on the Capital screen, refused every USDG binding at
 * the publish gate, and told the New binding screen "every binding settles in
 * USDC · solana:…". Measured 2026-09-25.
 */
describe('platformAssetFrom', () => {
  it('is the configured asset when PLATFORM_STAKE_ASSET_ID is set', () => {
    expect(
      platformAssetFrom(
        config({
          PLATFORM_STAKE_ASSET_ID: ASSET_IDS.USDC_SOLANA_DEVNET,
          ENABLED_CHAINS: CHAIN_IDS.ROBINHOOD_TESTNET,
        }),
      ),
    ).toBe(ASSET_IDS.USDC_SOLANA_DEVNET);
  });

  it("is the first enabled chain's settlement asset when it is not", () => {
    expect(platformAssetFrom(config({ ENABLED_CHAINS: CHAIN_IDS.ROBINHOOD_TESTNET }))).toBe(
      ASSET_IDS.USDG_ROBINHOOD_TESTNET,
    );
  });

  it('treats an empty PLATFORM_STAKE_ASSET_ID as unset — how a copied .env.example arrives', () => {
    expect(
      platformAssetFrom(
        config({ PLATFORM_STAKE_ASSET_ID: '  ', ENABLED_CHAINS: CHAIN_IDS.ROBINHOOD_TESTNET }),
      ),
    ).toBe(ASSET_IDS.USDG_ROBINHOOD_TESTNET);
  });

  it('falls back to devnet USDC only when nothing names a chain', () => {
    expect(platformAssetFrom(config())).toBe(ASSET_IDS.USDC_SOLANA_DEVNET);
    // An unparseable list is ChainsModule's to refuse at boot, not this helper's.
    expect(platformAssetFrom(config({ ENABLED_CHAINS: 'not a chain' }))).toBe(
      ASSET_IDS.USDC_SOLANA_DEVNET,
    );
  });
});
