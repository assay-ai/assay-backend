import { ConfigService } from '@nestjs/config';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import {
  loadMinimumStakeByChain,
  loadMinimumStakeParameters,
} from '@modules/provider/services/provider-stake.service';

const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;

const config = (values: Record<string, string | undefined> = {}) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

/**
 * The per-chain minimum-stake boot assertion, made satisfiable.
 *
 * `loadMinimumStakeParameters` reads ONE `PLATFORM_STAKE_ASSET_ID` and a
 * hardcoded `decimals: 6`, so `minimumStakeByChain` was a one-entry map however
 * many chains `ENABLED_CHAINS` named — and `ROUTER_CONFIG` then refused to boot.
 * That refusal was deliberate and correct (a deployment must not serve paid
 * calls on a chain whose collateral it cannot price), and it meant **the second
 * chain could not be turned on without changing that function**.
 *
 * The floor's *amount* is one number — `$50` — and a discount on any chain is
 * forbidden, so it is the same on each. Its *asset* is per chain,
 * and it is not a new environment variable: it is the chain's own declared
 * settlement asset, which `assertChainMetadata` already holds to `USD-1:1` at 6
 * decimals at boot. So "$50 on each chain, in that chain's asset" is a
 * derivation rather than a configuration, and there is nothing new for an
 * operator to get wrong.
 */
describe('the minimum stake floor, per chain', () => {
  it("covers TWO chains, in each chain's own settlement asset", () => {
    const byChain = loadMinimumStakeByChain(config(), [SOLANA, EVM]);

    expect([...byChain.keys()].sort()).toEqual([SOLANA, EVM].sort());
    expect(byChain.get(SOLANA)!.floor.asset).toBe(ASSET_IDS.USDC_SOLANA_DEVNET);
    expect(byChain.get(EVM)!.floor.asset).toBe(ASSET_IDS.USDG_ROBINHOOD_TESTNET);
  });

  it('applies the FULL floor on each chain, never a share of it', () => {
    // A discount on any chain would mean calls there are backed by
    // collateral the chain enforcing them cannot see.
    const byChain = loadMinimumStakeByChain(config(), [SOLANA, EVM]);

    expect(byChain.get(SOLANA)!.floor.amount).toBe('50000000');
    expect(byChain.get(EVM)!.floor.amount).toBe('50000000');
    expect(byChain.get(EVM)!.priceMultiple).toBe(1000);
  });

  it('honours PROVIDER_MINIMUM_STAKE_FLOOR and _MULTIPLE on every chain at once', () => {
    const byChain = loadMinimumStakeByChain(
      config({ PROVIDER_MINIMUM_STAKE_FLOOR: '75000000', PROVIDER_MINIMUM_STAKE_MULTIPLE: '500' }),
      [SOLANA, EVM],
    );

    for (const chainId of [SOLANA, EVM]) {
      expect(byChain.get(chainId)!.floor.amount).toBe('75000000');
      expect(byChain.get(chainId)!.priceMultiple).toBe(500);
    }
  });

  it("takes each floor's DECIMALS from the asset registry, not from a literal", () => {
    // `decimals: 6` was hardcoded, and an 18-decimal collateral asset would have
    // been silently mis-scaled by twelve orders of magnitude.
    const byChain = loadMinimumStakeByChain(config(), [SOLANA, EVM]);

    expect(byChain.get(SOLANA)!.floor.decimals).toBe(6);
    expect(byChain.get(EVM)!.floor.decimals).toBe(6);
  });

  it('still keys each floor on the chain its own asset names', () => {
    // The invariant `eligibility.ts` relies on: a `Money.asset` is CAIP-19, so a
    // floor already names the chain it is a floor ON, and a map whose key
    // disagreed with its value's asset would make the stake gate compare a price
    // against a number that was never about it.
    const byChain = loadMinimumStakeByChain(config(), [SOLANA, EVM]);

    for (const [chainId, parameters] of byChain) {
      expect(chainIdOf(parameters.floor.asset)).toBe(chainId);
    }
  });

  it('refuses a chain with no metadata row', () => {
    // A floor derived for an undescribed chain would be a number about a token
    // nobody has registered.
    expect(() => loadMinimumStakeByChain(config(), [CHAIN_IDS.BASE_MAINNET])).toThrow();
  });

  it('derives a floor on Robinhood Chain mainnet, in mainnet USDG', () => {
    const byChain = loadMinimumStakeByChain(config(), [CHAIN_IDS.ROBINHOOD_MAINNET]);

    expect(byChain.get(CHAIN_IDS.ROBINHOOD_MAINNET)!.floor.asset).toBe(
      ASSET_IDS.USDG_ROBINHOOD_MAINNET,
    );
  });

  it('refuses when PLATFORM_STAKE_ASSET_ID names no enabled chain', () => {
    // The variable still exists and three other call sites read it. Left
    // unchecked it would be a stale value that silently agrees with nothing —
    // a shape that has locked providers out before, one chain over.
    expect(() =>
      loadMinimumStakeByChain(config({ PLATFORM_STAKE_ASSET_ID: ASSET_IDS.USDC_SOLANA_MAINNET }), [
        SOLANA,
        EVM,
      ]),
    ).toThrow(
      expect.objectContaining({
        errorCode: ProviderErrorCode.PROVIDER_MINIMUM_STAKE_UNCONFIGURED,
      }),
    );
  });

  it('accepts PLATFORM_STAKE_ASSET_ID when it names an enabled chain', () => {
    // The control. Today's single-chain deployments set it to devnet USDC and
    // must keep booting.
    expect(() =>
      loadMinimumStakeByChain(config({ PLATFORM_STAKE_ASSET_ID: ASSET_IDS.USDC_SOLANA_DEVNET }), [
        SOLANA,
        EVM,
      ]),
    ).not.toThrow();
  });

  it('refuses an empty enabled list rather than returning an empty map', () => {
    // An empty map makes `filterEligible` refuse every candidate with
    // STAKE_UNKNOWN — an RPC-shaped symptom for a configuration fault, which is
    // exactly what must fail at boot instead.
    expect(() => loadMinimumStakeByChain(config(), [] as readonly ChainId[])).toThrow();
  });

  describe('loadMinimumStakeParameters, the single-chain reader that stays', () => {
    it('reads decimals from the registry rather than hardcoding 6', () => {
      const parameters = loadMinimumStakeParameters(
        config({ PLATFORM_STAKE_ASSET_ID: ASSET_IDS.USDG_ROBINHOOD_TESTNET }),
      );

      expect(parameters.floor.asset).toBe(ASSET_IDS.USDG_ROBINHOOD_TESTNET);
      expect(parameters.floor.decimals).toBe(6);
    });

    it('still defaults to devnet USDC at $50 and 1000× when nothing names a chain', () => {
      const parameters = loadMinimumStakeParameters(config());

      expect(parameters.floor.asset).toBe(ASSET_IDS.USDC_SOLANA_DEVNET);
      expect(parameters.floor.amount).toBe('50000000');
      expect(parameters.priceMultiple).toBe(1000);
    });

    it("defaults to the first ENABLED chain's settlement asset, never to a chain that is off", () => {
      // Measured against a deployed environment: ENABLED_CHAINS=eip155:46630 and no
      // PLATFORM_STAKE_ASSET_ID, so the floor was devnet USDC — the Capital
      // screen grew a Solana row, and every USDG binding was refused by the
      // requirement and the publish gate as "priced in USDG, floor in USDC".
      expect(loadMinimumStakeParameters(config({ ENABLED_CHAINS: EVM })).floor.asset).toBe(
        ASSET_IDS.USDG_ROBINHOOD_TESTNET,
      );
      expect(
        loadMinimumStakeParameters(config({ ENABLED_CHAINS: `${EVM},${SOLANA}` })).floor.asset,
      ).toBe(ASSET_IDS.USDG_ROBINHOOD_TESTNET);
    });

    it('lets PLATFORM_STAKE_ASSET_ID win over the derivation', () => {
      expect(
        loadMinimumStakeParameters(
          config({
            ENABLED_CHAINS: EVM,
            PLATFORM_STAKE_ASSET_ID: ASSET_IDS.USDC_SOLANA_DEVNET,
          }),
        ).floor.asset,
      ).toBe(ASSET_IDS.USDC_SOLANA_DEVNET);
    });
  });
});
