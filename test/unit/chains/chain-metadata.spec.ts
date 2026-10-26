import {
  assertChainMetadata,
  chainMetadata,
  describedChains,
} from '@modules/chains/chain-metadata';
import {
  ASSET_IDS,
  getAssetMetadata,
  registeredAssets,
} from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS, ChainId, toChainId } from '@modules/chains/ports/caip.types';

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const MAINNET = CHAIN_IDS.SOLANA_MAINNET;
/** Robinhood Chain **mainnet**. */
const RHC = CHAIN_IDS.ROBINHOOD_MAINNET;
/** Robinhood Chain **testnet**. */
const RHC_TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
/** A chain this table does not describe. */
const UNDESCRIBED = toChainId('eip155', '8453');

/**
 * The boot gate on the two tables `ChainAdapterRegistry` does not cover.
 *
 * ## The state this deletes, measured rather than reasoned
 *
 * Before this assertion existed, an enabled chain with no metadata row behaved
 * differently depending on whether an adapter served it, and neither behaviour
 * was acceptable:
 *
 * - A chain no adapter serves fails at boot from the REGISTRY. The metadata
 *   gap is masked, so it looks handled and is not.
 * - With an `eip155` adapter registered, the mask is gone. The registry
 *   accepts the chain and the first `GET /chains` throws `CHAIN_UNSUPPORTED`:
 *   **HTTP 400**, "No chain adapter is enabled for <chain>". An adapter IS
 *   enabled, so the message points at the wrong file; 400 blames a caller who
 *   sent no input; and 400 is invisible to 5xx alerting, so a broken deploy
 *   pages nobody.
 *
 * Both are captured below as the SHAPE this must not have — a 4xx — so that
 * re-introducing a request-time fallback fails here and not in production.
 */
describe('assertChainMetadata — the boot gate', () => {
  it('accepts the chains the table actually describes', () => {
    expect(() => assertChainMetadata([MAINNET, DEVNET])).not.toThrow();
    expect(() => assertChainMetadata([])).not.toThrow();
  });

  it('refuses an enabled chain with no metadata row', () => {
    expect(() => assertChainMetadata([DEVNET, UNDESCRIBED])).toThrow(/eip155:8453/);
  });

  it('names EVERY missing chain, not just the first — an operator edits one deployment config', () => {
    const other = toChainId('eip155', '10');

    try {
      assertChainMetadata([UNDESCRIBED, DEVNET, other]);
      throw new Error('expected assertChainMetadata to throw');
    } catch (error) {
      const message = (error as { message: string }).message;
      expect(message).toContain('eip155:8453');
      expect(message).toContain('eip155:10');
      // and says what IS available, so the fix does not need a second round trip
      expect(message).toContain(DEVNET);
    }
  });

  it('fails as a 500, because a misconfigured deployment is not a bad request', () => {
    // The whole point of moving this to boot. `CHAIN_UNSUPPORTED` is 400, and a
    // 400 for an operator's deployment config error is both a lie and invisible to the
    // alerting that watches 5xx. If this ever reads 400 again, the request-time
    // fallback is back.
    try {
      assertChainMetadata([UNDESCRIBED]);
      throw new Error('expected assertChainMetadata to throw');
    } catch (error) {
      expect((error as { statusCode: number }).statusCode).toBe(500);
      expect((error as { errorCode: string }).errorCode).toBe('CHAIN_ENABLED_CHAINS_INVALID');
    }
  });

  /**
   * The second half of the gate, and the money-shaped one.
   *
   * `settlementAsset` used to be `registeredAssets().find(a => a.chainId ===
   * chainId)` — the first asset registered on the chain. Registering a second
   * asset ABOVE the current one in `asset-registry.ts` then changed both the
   * advertised asset and its `decimals`, decided by literal ordering, with
   * nothing to notice. `decimals` is what a client multiplies by to reach minor
   * units.
   *
   * It is a declaration now, so ordering cannot reach it. What is left to
   * assert is that the declaration is not a typo.
   */
  describe('the declared settlement asset', () => {
    it('is a registered asset that lives on its own chain', () => {
      for (const chainId of describedChains()) {
        const asset = chainMetadata(chainId).settlementAsset;
        expect(() => getAssetMetadata(asset)).not.toThrow();
        expect(getAssetMetadata(asset).chainId).toBe(chainId);
      }
    });

    it('is the asset the registry knows, so decimals never come from this table', () => {
      expect(chainMetadata(DEVNET).settlementAsset).toBe(ASSET_IDS.USDC_SOLANA_DEVNET);
      expect(chainMetadata(MAINNET).settlementAsset).toBe(ASSET_IDS.USDC_SOLANA_MAINNET);
      expect(chainMetadata(RHC).settlementAsset).toBe(ASSET_IDS.USDG_ROBINHOOD_MAINNET);
    });
  });

  it('describes exactly the chains it declares, and the enabled list is not among them', () => {
    // The negative half of the boot gate applied to this file: a table that knew which
    // chains were live would be a second answer to the question ENABLED_CHAINS
    // exists to answer alone.
    expect([...describedChains()].sort()).toEqual(
      [MAINNET, DEVNET, RHC, RHC_TESTNET].sort() as ChainId[],
    );
  });

  describe('eip155:4663 — Robinhood Chain mainnet', () => {
    it('is described, with a display name that does not say testnet', () => {
      expect(describedChains()).toContain(RHC);
      const row = chainMetadata(RHC);
      expect(row.displayName).toBe('Robinhood Chain');
      expect(row.displayName.toLowerCase()).not.toContain('testnet');
      expect(row.explorerBaseUrl).toBe('https://robinhoodchain.blockscout.com');
    });

    it('settles in mainnet USDG, a constant with its exact EIP-55 spelling', () => {
      expect(ASSET_IDS.USDG_ROBINHOOD_MAINNET).toBe(
        'eip155:4663/erc20:0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      );
      expect(getAssetMetadata(ASSET_IDS.USDG_ROBINHOOD_MAINNET)).toEqual({
        assetId: ASSET_IDS.USDG_ROBINHOOD_MAINNET,
        symbol: 'USDG',
        decimals: 6,
        chainId: RHC,
        peg: 'USD-1:1',
      });
      expect(registeredAssets().map((asset) => asset.chainId)).toContain(RHC);
    });

    it('passes the boot assertions alone (ENABLED_CHAINS=eip155:4663)', () => {
      expect(() => assertChainMetadata([RHC])).not.toThrow();
    });

    it('can be enabled beside the testnet and Solana', () => {
      expect(() => assertChainMetadata([RHC, RHC_TESTNET])).not.toThrow();
      expect(() => assertChainMetadata([DEVNET, RHC, RHC_TESTNET])).not.toThrow();
    });

    it('does not share an asset with the testnet', () => {
      expect(chainMetadata(RHC).settlementAsset).not.toBe(
        chainMetadata(RHC_TESTNET).settlementAsset,
      );
    });
  });

  /**
   * A chain's settlement asset must be 1:1 with the platform's unit of
   * account and 6 dp, or `price_amount` (USD minor units, scale 6) needs an
   * oracle to become a chain `Money`, and an oracle is a new trusted input on
   * the paying path.
   *
   * Both guards below are vacuous against the committed tables — every
   * registered asset is pegged and 6 dp — which is the correct steady state for
   * a boot assertion. They were mutation-proved by hand instead.
   */
  describe('the settlement asset of every described chain', () => {
    it('is pegged 1:1 and 6 dp', () => {
      for (const chainId of describedChains()) {
        const asset = getAssetMetadata(chainMetadata(chainId).settlementAsset);
        expect({ chainId, peg: asset.peg, decimals: asset.decimals }).toEqual({
          chainId,
          peg: 'USD-1:1',
          decimals: 6,
        });
      }
    });

    it('passes assertChainMetadata for every chain the table describes', () => {
      expect(() => assertChainMetadata(describedChains())).not.toThrow();
    });
  });

  /**
   * The rule: Solana offers no paid rail today (rail B is off until its
   * program has the tighten-delay rule, and rail A is off while B is —
   * review 2026-10-15 C1), 4663 ships B only. Declared here because it is a
   * property of what the deployment offers on that chain; enforced in `tool/`
   * and `mcp/`.
   */
  describe('rails', () => {
    it('is B only on Robinhood Chain, and empty on Solana', () => {
      expect(chainMetadata(RHC_TESTNET).rails).toEqual(['B']);
      expect(chainMetadata(RHC).rails).toEqual(['B']);
      // Rail B is off on Solana until the Anchor program binds a buyer's
      // tightening to already-signed vouchers only after a delay, as the EVM
      // contract will (no-platform-debt design §3, step 5). Rail A spends a
      // ledger mirror the buyer can withdraw from under it, so it is off too.
      expect(chainMetadata(DEVNET).rails).toEqual([]);
      expect(chainMetadata(MAINNET).rails).toEqual([]);
    });

    it('boots with a chain that offers no paid rail: it serves free calls only', () => {
      expect(() => assertChainMetadata([DEVNET])).not.toThrow();
    });
  });
});
