import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { ReconciliationJob } from '@modules/settlement/jobs/reconciliation.job';
import { ReconciliationService } from '@modules/settlement/services/reconciliation.service';

const SOLANA_DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const ROBINHOOD_TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;

const USDC_SOLANA_DEVNET = ASSET_IDS.USDC_SOLANA_DEVNET;
const USDG_46630 = ASSET_IDS.USDG_ROBINHOOD_TESTNET;

/**
 * `ReconciliationJob`'s work list, with a second **namespace** in it.
 *
 * "An asset loop IS a chain loop" is the load-bearing sentence of the whole
 * per-chain reconciler, and until `eip155:46630` was registered it was only
 * ever exercised across two Solana clusters — which share an asset registry
 * shape, a decimals count and a namespace. `no-cross-chain-invariant.spec.ts`
 * pins the shape and the two-Solana behaviour; this file pins the same claim
 * with the chains that are actually different, and it does so by ASSERTING THE
 * CALLS rather than by reading the code.
 *
 * `assets()` stays private on purpose. What matters is which assets are
 * reconciled, and that is observable from `reconcile`; widening a method's
 * visibility so a test can read it would let the list and the loop drift apart
 * while the test went on passing about the list.
 */
function reconciledBy(enabled: readonly ChainId[]): Promise<AssetId[]> {
  const reconcile = jest.fn().mockResolvedValue(undefined);
  const job = new ReconciliationJob(
    { reconcile } as unknown as ReconciliationService,
    {
      enabledChains: () => [...enabled],
    } as unknown as ChainAdapterRegistry,
  );

  return job
    .handleReconciliation()
    .then(() => reconcile.mock.calls.map(([asset]: [AssetId]) => asset));
}

describe('ReconciliationJob across two namespaces', () => {
  it('visits USDG exactly once when eip155:46630 is enabled, and not at all when it is not', async () => {
    await expect(reconciledBy([SOLANA_DEVNET, ROBINHOOD_TESTNET])).resolves.toEqual([
      USDC_SOLANA_DEVNET,
      USDG_46630,
    ]);
    // The other direction, and the one that is not a restatement: a job that
    // hard-coded the registry's whole asset list would pass the first
    // assertion and fail this one.
    await expect(reconciledBy([SOLANA_DEVNET])).resolves.toEqual([USDC_SOLANA_DEVNET]);
  });

  it('never folds two chains into one call', async () => {
    const reconcile = jest.fn().mockResolvedValue(undefined);
    const job = new ReconciliationJob(
      { reconcile } as unknown as ReconciliationService,
      {
        enabledChains: () => [SOLANA_DEVNET, ROBINHOOD_TESTNET],
      } as unknown as ChainAdapterRegistry,
    );

    await job.handleReconciliation();

    // TWO calls, each naming ONE asset. A single call with an array — or any
    // aggregate over both — is the failure `no-cross-chain-invariant.spec.ts`
    // exists to refuse, and it would not be OBSERVABLE at all until the second
    // chain went live.
    expect(reconcile.mock.calls).toEqual([[USDC_SOLANA_DEVNET], [USDG_46630]]);
  });

  it('reconciles 46630 identically whether or not Solana is enabled', async () => {
    // Chain independence, operationally, in the direction a Solana-only setup
    // could not test: the EVM chain's call must be byte-identical with Solana
    // on and with Solana off. Turning one chain off is the cheapest way to discover that the
    // other one was depending on it.
    const withBoth = await reconciledBy([SOLANA_DEVNET, ROBINHOOD_TESTNET]);
    const evmOnly = await reconciledBy([ROBINHOOD_TESTNET]);

    expect(evmOnly).toEqual([USDG_46630]);
    expect(evmOnly[0]).toEqual(withBoth.find((asset) => asset === USDG_46630));
  });

  it('one asset per chain, so a chain contributes exactly one pass', async () => {
    // The premise the whole design rests on, asserted rather than assumed: if
    // a chain ever registered two settlement assets, "an asset loop is a chain
    // loop" would still be true but "one pass per chain" would not — and the
    // freeze, which is keyed on the asset, would freeze half a chain.
    const perChain = await Promise.all(
      [SOLANA_DEVNET, ROBINHOOD_TESTNET].map((chainId) => reconciledBy([chainId])),
    );
    expect(perChain.map((assets) => assets.length)).toEqual([1, 1]);
  });
});
