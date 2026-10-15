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
/**
 * Robinhood Chain **mainnet** — the chain this table deliberately cannot
 * describe. See `refuses eip155:4663 at boot` below for why that is the
 * deliverable rather than a gap.
 */
const RHC = CHAIN_IDS.ROBINHOOD_MAINNET;
/** Robinhood Chain **testnet** — the one EVM chain enabled today. */
const RHC_TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;

/**
 * The boot gate on the two tables `ChainAdapterRegistry` does not cover.
 *
 * ## The state this deletes, measured rather than reasoned
 *
 * Before this assertion existed, an enabled chain with no metadata row behaved
 * differently depending on whether an adapter served it, and neither behaviour
 * was acceptable:
 *
 * - `ENABLED_CHAINS=eip155:4663` on this tree fails at boot — from the
 *   REGISTRY, because no adapter serves it. The metadata gap is masked, so it
 *   looks handled and is not.
 * - With an `eip155` adapter registered, the mask is gone. The registry
 *   accepts the chain and the first `GET /chains` throws `CHAIN_UNSUPPORTED`:
 *   **HTTP 400**, "No chain adapter is enabled for eip155:4663". An adapter IS
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
    expect(() => assertChainMetadata([DEVNET, RHC])).toThrow(/eip155:4663/);
  });

  it('names EVERY missing chain, not just the first — an operator edits one deployment config', () => {
    const other = toChainId('eip155', '8453');

    try {
      assertChainMetadata([RHC, DEVNET, other]);
      throw new Error('expected assertChainMetadata to throw');
    } catch (error) {
      const message = (error as { message: string }).message;
      expect(message).toContain('eip155:4663');
      expect(message).toContain('eip155:8453');
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
      assertChainMetadata([RHC]);
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
    });
  });

  it('describes exactly the chains it declares, and the enabled list is not among them', () => {
    // The negative half of the boot gate applied to this file: a table that knew which
    // chains were live would be a second answer to the question ENABLED_CHAINS
    // exists to answer alone.
    expect([...describedChains()].sort()).toEqual(
      [MAINNET, DEVNET, RHC_TESTNET].sort() as ChainId[],
    );
  });

  /**
   * `eip155:4663` is refused at boot, and that refusal is deliberate.
   *
   * `docs/chain-facts.md` in assay-evm records `cast code` at the testnet USDG
   * address on 4663 and got `0x` — the empty-code answer — with an 11,306-byte
   * control against testnet proving the probe works. So the mainnet USDG
   * address is unmeasured. A settlement asset cannot honestly be registered for
   * a token nobody has read, and `chain-metadata.ts` therefore has no 4663 row
   * at all.
   *
   * The tests below say **which** guard refuses it, not merely that something
   * did. Naming the wrong guard is how a suite goes green while the thing it
   * claims to cover has moved: "its settlement asset is not registered" would
   * be a plausible name and a false one, because the row is missing before the
   * asset is ever consulted.
   */
  describe('eip155:4663 — described nowhere, refused at boot', () => {
    it('is not a chain this table describes', () => {
      expect(describedChains()).not.toContain(RHC);
      expect(() => chainMetadata(RHC)).toThrow();
    });

    it('is refused by the missing-row guard, which names chain-metadata.ts', () => {
      try {
        assertChainMetadata([RHC]);
        throw new Error('expected assertChainMetadata to throw');
      } catch (error) {
        const message = (error as { message: string }).message;
        expect(message).toContain('eip155:4663');
        expect(message).toContain('src/modules/chains/chain-metadata.ts');
        // and NOT the asset table's message — the row is missing before the
        // settlement asset is ever looked at.
        expect(message).not.toContain('asset-registry.ts');
      }
    });

    it('has no registered asset either, so copying the testnet row across is not a fix', () => {
      // The other half. Somebody "fixing" the boot failure would reach for the
      // testnet USDG address; there is deliberately no mainnet entry to find.
      expect(registeredAssets().map((asset) => asset.chainId)).not.toContain(RHC);
    });

    it('accepts eip155:46630 — the positive control for every refusal above', () => {
      expect(() => assertChainMetadata([RHC_TESTNET])).not.toThrow();
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
   * The rule: *"`SUPPORTED_RAILS` is per-chain: Solana offers A
   * only (rail B is off until its program has the tighten-delay rule), 4663
   * ships B only."* Declared here because it is a property of what the deployment
   * offers on that chain; enforced in `tool/`.
   */
  describe('rails', () => {
    it('is B only on Robinhood Chain, and both on Solana', () => {
      expect(chainMetadata(RHC_TESTNET).rails).toEqual(['B']);
      // Rail B is off on Solana until the Anchor program binds a buyer's
      // tightening to already-signed vouchers only after a delay, as the EVM
      // contract will (no-platform-debt design §3, step 5).
      expect(chainMetadata(DEVNET).rails).toEqual(['A']);
      expect(chainMetadata(MAINNET).rails).toEqual(['A']);
    });

    it('is non-empty on every described chain — a chain with no rail cannot be paid on', () => {
      for (const chainId of describedChains()) {
        expect({ chainId, rails: chainMetadata(chainId).rails.length }).not.toEqual({
          chainId,
          rails: 0,
        });
      }
    });
  });
});
