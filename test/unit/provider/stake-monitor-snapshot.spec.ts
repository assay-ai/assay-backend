import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId, chainIdOf } from '@modules/chains/ports/caip.types';
import { PricingMode } from '@modules/tool/ports/tool.types';

import {
  ACCOUNT_A,
  ACCOUNT_B,
  ASSET,
  BINDING_A,
  NOW,
  PROVIDER_A,
  PROVIDER_B,
  binding,
  harness,
  onChainStake,
  provider,
  stakeMap,
  usdc,
  CHAIN,
} from './helpers/stake-monitor-harness';

/** A second Solana chain and its asset — "per binding" without an EVM adapter. */
const OTHER_ASSET = ASSET_IDS.USDC_SOLANA_MAINNET as AssetId;
const OTHER_CHAIN = chainIdOf(OTHER_ASSET);

/**
 * The fleet stake snapshot the sweep writes, which the public
 * proof-of-reserves page reads back.
 *
 * The figure has to come off the chain, and a failed read has to leave the last
 * good snapshot standing rather than publish a zero. Those two properties are
 * what this suite is for; the grace half is proved next door, over the same
 * harness.
 */
describe('StakeMonitorService — the fleet stake snapshot', () => {
  const PROVIDER_C = '33333333-3333-4333-8333-333333333333';

  it('snapshots the fleet total off a pure chain reading', async () => {
    // The total is summed from `bondedStakeOf` and nothing else — the chain
    // itself, not the router's cached stake source.
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A), provider(PROVIDER_B, ACCOUNT_B)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      stakes: stakeMap([[PROVIDER_A, '80000000']]),
      onChain: new Map([
        [ACCOUNT_A, onChainStake(ACCOUNT_A, usdc('80000000'))],
        [ACCOUNT_B, onChainStake(ACCOUNT_B, usdc('45000000'))],
      ]),
    });
    await expect(h.service.sweep()).resolves.not.toThrow();

    expect(h.snapshots.insertSnapshot).toHaveBeenCalledTimes(1);
    expect(h.snapshots.insertSnapshot).toHaveBeenCalledWith({
      readAt: NOW,
      stakeAsset: ASSET,
      decimals: 6,
      bondedTotal: '125000000',
      providerCount: 2,
    });
  });

  it('counts providers with a stake account, not providers', async () => {
    // `provider_count` is published. The accounts list is filtered to a
    // non-null, non-empty `stakeAuthority` before the read, so a registered
    // provider that never opened a stake account is not in the total and must
    // not be in the count either.
    const h = harness({
      providers: [
        provider(PROVIDER_A, ACCOUNT_A),
        provider(PROVIDER_B, ACCOUNT_B),
        provider(PROVIDER_C, null),
      ],
      onChain: new Map([
        [ACCOUNT_A, onChainStake(ACCOUNT_A, usdc('10000000'))],
        [ACCOUNT_B, onChainStake(ACCOUNT_B, usdc('20000000'))],
      ]),
    });

    await h.service.sweep();

    expect(h.snapshots.insertSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ bondedTotal: '30000000', providerCount: 2 }),
    );
  });

  it('writes nothing when the chain read fails — never a zero', async () => {
    // A zero is a claim that the fleet has no stake. The page must show the
    // previous snapshot with its older timestamp instead.
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      stakes: stakeMap([[PROVIDER_A, '40000000']]),
    });
    h.onChain.bondedStakeOf.mockRejectedValue(new Error('rpc timeout'));

    await expect(h.service.sweep()).resolves.not.toThrow();

    expect(h.snapshots.insertSnapshot).not.toHaveBeenCalled();
    // And the grace half still ran — the RPC is outside its own error boundary
    // only if this regressed.
    expect(h.grace.insert).toHaveBeenCalledTimes(1);
  });

  it('reads the chain once per sweep, whatever the fleet size', async () => {
    // The batch is the point: the cost is ceil(N/100) round trips once per
    // pass, never one read per provider.
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A), provider(PROVIDER_B, ACCOUNT_B)],
      onChain: new Map([
        [ACCOUNT_A, onChainStake(ACCOUNT_A, usdc('60000000'))],
        [ACCOUNT_B, onChainStake(ACCOUNT_B, usdc('10000000'))],
      ]),
    });

    await h.service.sweep();

    expect(h.onChain.bondedStakeOf).toHaveBeenCalledTimes(1);
    expect(h.snapshots.insertSnapshot).toHaveBeenCalledTimes(1);
  });

  it('writes a zero-provider snapshot for a fleet with no stake accounts at all', async () => {
    // Distinct from the failed-read case above: the chain answered, and the
    // honest answer is that nothing is staked. That IS publishable, and the
    // count of zero is what makes it readable as such.
    const h = harness({ providers: [provider(PROVIDER_A, null)] });

    await h.service.sweep();

    expect(h.snapshots.insertSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ bondedTotal: '0', providerCount: 0 }),
    );
  });

  it('does not let a snapshot write failure stop the sweep', async () => {
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      stakes: stakeMap([[PROVIDER_A, '40000000']]),
      onChain: new Map([[ACCOUNT_A, onChainStake(ACCOUNT_A, usdc('60000000'))]]),
    });
    h.snapshots.insertSnapshot.mockRejectedValue(new Error('unique violation'));

    await expect(h.service.sweep()).resolves.not.toThrow();

    expect(h.grace.insert).toHaveBeenCalledTimes(1);
  });
});

/**
 * Which chain the sweep asks about, per binding.
 *
 * **Site 4 of 5** in the settlement-chain enumeration in
 * `tool/domain/routing/eligibility.ts`, and the half of it that is closable
 * without a second stake floor: the KEYS the monitor asks `stakeOn` for.
 *
 * The other half — the grace clock actually counting against a second chain's
 * reading — needs a binding priced in a second asset AND a second floor,
 * because `requirementFor` is floor-denominated and would refuse such a binding
 * with an asset mismatch before the clock ran. That multi-chain fixture work is
 * not done here, and it is not faked either.
 *
 * What this pins is that a monitor deriving the chain from the FLOOR rather
 * than from each binding asks the wrong question — which is invisible while
 * every fixture binding is priced in the floor's asset, and is exactly the
 * degenerate that survived the first round.
 */
describe('StakeMonitorService — the stake keys come from the BINDINGS', () => {
  const PROVIDER_C = '33333333-3333-4333-8333-333333333333';

  it('asks about each binding’s own chain, not the floor’s', async () => {
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A), provider(PROVIDER_C, null)],
      bindings: [
        binding(BINDING_A, PROVIDER_A, '50000'),
        // A second Solana chain id, so "per binding" is expressible without an
        // EVM adapter. It lands in `STAKE_ASSET_MISMATCH` territory inside
        // `requirementFor` — which is fine and is the point: the QUESTION is
        // asked before the requirement is resolved, so the key set is
        // observable even though the clock will not run for it.
        binding(
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          PROVIDER_C,
          '50000',
          PricingMode.PAID,
          OTHER_ASSET,
        ),
      ],
      stakes: stakeMap([[PROVIDER_A, '80000000']]),
    });

    await h.service.sweep();

    expect(h.stakes.stakeOn).toHaveBeenCalledWith(
      expect.arrayContaining([
        { providerId: PROVIDER_A, chainId: CHAIN },
        { providerId: PROVIDER_C, chainId: OTHER_CHAIN },
      ]),
    );
    // Exactly the two distinct pairs the bindings name — not the cross product,
    // and not one key per binding.
    expect(h.stakes.stakeOn.mock.calls[0][0]).toHaveLength(2);
  });
});
