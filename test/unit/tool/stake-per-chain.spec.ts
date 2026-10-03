import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS, chainIdOf } from '@modules/chains/ports/caip.types';
import { ProviderStake } from '@modules/provider/ports/provider-stake.port';
import {
  IneligibilityReason,
  MinimumStakeParameters,
  evaluateStakeGate,
  filterEligible,
} from '@modules/tool/domain/routing';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { AppError } from '@shared/errors/app-errors';
import { MoneyUtil } from '@utils/money.util';

import {
  MINIMUM_STAKE,
  MINIMUM_STAKE_BY_CHAIN,
  PAYOUT_ACCOUNT,
  PAYOUT_CHAIN,
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildCandidate,
  buildProvider,
  buildRouter,
  ok,
  routingContext,
  usdc,
} from './helpers/routing-fixtures';

/**
 * **Stake is per chain, and a provider must stake on every chain it
 * serves.**
 *
 * ## What this is defending
 *
 * A slash is executed by the settlement contract of the chain the call was paid
 * on. Collateral posted on Solana is invisible and unreachable to a contract on
 * `eip155:4663`, and the reverse. So "how much has this provider staked" has one
 * answer per chain, and a gate that answered it once — the earlier shape —
 * would admit a 4663 call against Solana collateral nothing on 4663 can
 * take. The premise the whole stake gate rests on ("a provider who defects loses
 * more than they gained") is then quietly false, and nothing observable fails
 * until somebody tries to slash.
 *
 * ## Two chain ids and no EVM code anywhere
 *
 * Every case here uses two **Solana** chain ids, because this is a property of
 * the decision logic and the decision logic never learns what a chain is. A
 * suite that needed an EVM adapter to state it would be testing the adapter.
 *
 * ## What each `describe` rules out
 *
 * They are written against the four ways this could be implemented and look
 * finished:
 *
 * 1. a gate that takes `chainId` and uses it **only in its message**;
 * 2. a stake map that answers a missing chain from **another chain's** reading;
 * 3. a floor lookup that returns the **sole entry** of `minimumStakeByChain`;
 * 4. a producer that files the **same reading under every chain**.
 */

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const MAINNET = CHAIN_IDS.SOLANA_MAINNET;
const MAINNET_USDC = ASSET_IDS.USDC_SOLANA_MAINNET as AssetId;

/** A payout address on mainnet, so the payout gate is not what refuses these. */
const MAINNET_PAYOUT = `${MAINNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` as AccountId;

function mainnetUsdc(whole: number): ReturnType<typeof usdc> {
  return MoneyUtil.of(`${whole}000000`, MAINNET_USDC, 6);
}

/** The same `max($50, 1000 × price)` rule, denominated on mainnet. */
const MAINNET_MINIMUM_STAKE: MinimumStakeParameters = Object.freeze({
  floor: mainnetUsdc(50),
  priceMultiple: 1000,
});

function reading(providerId: string, chainId: string, staked: ReturnType<typeof usdc>) {
  return {
    providerId,
    chainId: chainId as typeof DEVNET,
    staked,
    observedAt: new Date(0),
  } satisfies ProviderStake;
}

describe('stake is per chain', () => {
  it('passes on a chain that is funded and refuses on one that is not — same provider', () => {
    // The invariant, in one assertion pair: a provider unstaking below the
    // minimum on one chain must make every binding of theirs stop being
    // routable ON THAT CHAIN ONLY. Bindings on the other chain are untouched —
    // that is the independence principle applied correctly.
    //
    // This is also degenerate (1)'s executioner: a gate that took `chainId` and
    // only interpolated it into the failure detail would answer both calls from
    // whichever reading it happened to pick, and one of these two lines would
    // be wrong whichever one that was.
    const candidate = buildCandidate('p', {
      stakeByChain: new Map([
        [DEVNET, reading('p', DEVNET, usdc(1000))],
        [MAINNET, reading('p', MAINNET, usdc(1))],
      ]),
    });

    expect(evaluateStakeGate(candidate, DEVNET, MINIMUM_STAKE).passed).toBe(true);

    const mainnet = evaluateStakeGate(candidate, MAINNET, MINIMUM_STAKE);
    expect(mainnet.passed).toBe(false);
    expect(mainnet).toMatchObject({ reason: IneligibilityReason.STAKE_BELOW_MINIMUM });
  });

  it('answers STAKE_UNKNOWN for a chain with no reading — never falls back to another chain', () => {
    // Degenerate (2). The failure this rules out is a gate that reads "the"
    // stake and compares it against whichever chain it was asked about. That
    // version passes the case above (both readings exist) and quietly routes a
    // 4663 call against Solana collateral no contract on 4663 can see.
    const candidate = buildCandidate('p', {
      stakeByChain: new Map([[DEVNET, reading('p', DEVNET, usdc(1000))]]),
    });

    const verdict = evaluateStakeGate(candidate, MAINNET, MINIMUM_STAKE);

    expect(verdict.passed).toBe(false);
    expect(verdict).toMatchObject({ reason: IneligibilityReason.STAKE_UNKNOWN });
    expect((verdict as { detail: string }).detail).toContain(MAINNET);
  });

  it('a reading filed under the wrong chain is refused, not used', () => {
    // Defence in depth against a source that builds the map with the wrong key.
    // The `chainId` on the reading is written by whoever read the chain; the
    // key is written by whoever built the map. When the two disagree one of
    // them is a bug, and this layer must not assume which.
    const candidate = buildCandidate('p', {
      stakeByChain: new Map([[DEVNET, reading('p', MAINNET, usdc(1000))]]),
    });

    expect(evaluateStakeGate(candidate, DEVNET, MINIMUM_STAKE).passed).toBe(false);
    expect(evaluateStakeGate(candidate, DEVNET, MINIMUM_STAKE)).toMatchObject({
      reason: IneligibilityReason.STAKE_UNKNOWN,
    });
  });

  it('refuses an empty stake map without reading another candidate’s', () => {
    // The fail-closed default. `stakeByChain` is empty, never null, so "no
    // reading at all" and "no reading for this chain" are the same refusal
    // rather than two spellings of it.
    const candidate = buildCandidate('p', { staked: null });

    expect(evaluateStakeGate(candidate, PAYOUT_CHAIN, MINIMUM_STAKE)).toMatchObject({
      passed: false,
      reason: IneligibilityReason.STAKE_UNKNOWN,
    });
  });
});

describe('filterEligible resolves the floor for the settlement chain', () => {
  /**
   * A buyer who can pay on either chain, so the chain gate narrows nothing and
   * the mainnet-priced candidates below reach the stake gate on MAINNET — which
   * is the chain their `settlementChains` names, because `buildBinding` derives
   * it from the asset each of them overrides.
   */
  const MAINNET_BUYER = routingContext({
    payerChains: [PAYOUT_CHAIN, MAINNET],
    enabledChains: [PAYOUT_CHAIN, MAINNET],
  });

  /** A candidate priced on mainnet, payable on mainnet, with a declared stake there. */
  function mainnetCandidate(staked: ReturnType<typeof usdc> | null) {
    return buildCandidate('p', {
      binding: { assetId: MAINNET_USDC, priceAmount: mainnetUsdc(0).amount },
      provider: { payoutAccountByChain: new Map([[MAINNET, MAINNET_PAYOUT]]) },
      stakeByChain: staked ? new Map([[MAINNET, reading('p', MAINNET, staked)]]) : new Map(),
    });
  }

  it('gates a mainnet binding on the MAINNET floor when both chains have one', () => {
    // Degenerate (3)'s executioner. With two entries in the map there is no
    // "sole entry" to return, so a lookup that ignores the chain has to pick —
    // and picking devnet's floor would compare a mainnet price against a floor
    // denominated in devnet USDC, which `evaluateStakeGate` reports as
    // `STAKE_ASSET_MISMATCH`. The candidate below is comfortably above the
    // mainnet floor and must simply be eligible.
    const byChain = new Map([
      [PAYOUT_CHAIN, MINIMUM_STAKE],
      [MAINNET, MAINNET_MINIMUM_STAKE],
    ]);

    const { eligible, rejected } = filterEligible(
      [mainnetCandidate(mainnetUsdc(1000))],
      byChain,
      MAINNET_BUYER,
    );

    expect(rejected).toEqual([]);
    expect(eligible).toHaveLength(1);
  });

  it('enforces the mainnet floor, not devnet’s, on a mainnet binding', () => {
    // The other half: below mainnet's own floor is a shortfall, and it is
    // reported as one rather than as an asset mismatch.
    const byChain = new Map([
      [PAYOUT_CHAIN, MINIMUM_STAKE],
      [MAINNET, MAINNET_MINIMUM_STAKE],
    ]);

    const { rejected } = filterEligible([mainnetCandidate(mainnetUsdc(1))], byChain, MAINNET_BUYER);

    expect(rejected[0]).toMatchObject({ reason: IneligibilityReason.STAKE_BELOW_MINIMUM });
  });

  it('refuses a settlement chain with no configured floor rather than borrowing one', () => {
    // A single-entry map, which is exactly what this deployment has today. A
    // lookup that returned the sole entry would hand the mainnet binding
    // devnet's floor; the honest answer is that no floor is configured for that
    // chain, and the detail says "configured" so a reader is not sent looking
    // for an RPC outage. (`ROUTER_CONFIG` throws at boot for any chain in
    // `ENABLED_CHAINS`, so this is only reachable for a chain the deployment
    // does not offer.)
    const { eligible, rejected } = filterEligible(
      [mainnetCandidate(mainnetUsdc(1000))],
      MINIMUM_STAKE_BY_CHAIN,
      MAINNET_BUYER,
    );

    expect(eligible).toEqual([]);
    expect(rejected[0]).toMatchObject({ reason: IneligibilityReason.STAKE_UNKNOWN });
    expect(rejected[0].detail).toContain('no minimum stake is configured for');
    expect(rejected[0].detail).toContain(MAINNET);
  });
});

describe('the router produces one stake reading per chain, not one per provider', () => {
  /**
   * One provider, two bindings, two chains, and a stake reading on each.
   *
   * The provider is payable on both chains and both chains have a floor, so the
   * stake gate is the only thing that can separate the two bindings — which is
   * what makes every assertion below a statement about the stake keys the
   * router asked for.
   */
  function twoChainRouter(
    devnetStake: ReturnType<typeof usdc>,
    mainnetStake: ReturnType<typeof usdc>,
  ) {
    const devnetBinding = buildBinding('p');
    const mainnetBinding = buildBinding('p', {
      id: 'binding-p-mainnet',
      assetId: MAINNET_USDC,
      priceAmount: mainnetUsdc(0).amount,
    });

    const provider = buildProvider('p', {
      payoutAccountByChain: new Map([
        [PAYOUT_CHAIN, PAYOUT_ACCOUNT],
        [MAINNET, MAINNET_PAYOUT],
      ]),
    });

    const { router } = buildRouter({
      bindings: [devnetBinding, mainnetBinding],
      providers: [provider],
      stakes: {},
      stakesByChain: {
        [`p|${PAYOUT_CHAIN}`]: devnetStake,
        [`p|${MAINNET}`]: mainnetStake,
      },
      config: {
        minimumStakeByChain: new Map([
          [PAYOUT_CHAIN, MINIMUM_STAKE],
          [MAINNET, MAINNET_MINIMUM_STAKE],
        ]),
      },
      invoker: new ScriptedInvoker({
        [devnetBinding.id]: async () => ok(),
        [mainnetBinding.id]: async () => ok(),
      }),
    });

    return { router, devnetBinding, mainnetBinding };
  }

  const call = {
    toolId: TOOL_ID,
    callId: 'stake-per-chain',
    input: { query: 'x' },
    // Both chains, so the chain gate narrows nothing and the stake gate is
    // what decides — which is this file's whole subject.
    context: routingContext({
      payerChains: [PAYOUT_CHAIN, MAINNET],
      enabledChains: [PAYOUT_CHAIN, MAINNET],
    }),
  };

  it('routes the funded chain and refuses the unfunded one, for the same provider', async () => {
    // Degenerate (4)'s executioner, and the only case here that runs through
    // `gatherCandidates`. 1000 USDC on devnet, 1 on mainnet. A producer that
    // filed one reading under every chain would make BOTH bindings routable (or
    // neither), and every other router test in this tree has one chain and
    // cannot tell the two apart.
    const { router, devnetBinding } = twoChainRouter(usdc(1000), mainnetUsdc(1));

    const result = await router.route(call);

    // The devnet binding is the only routable one, so it is the one invoked —
    // failover is excluded by construction, because both bindings belong to one
    // provider and `filterEligible` refuses the mainnet one before selection.
    expect(result.binding.id).toBe(devnetBinding.id);
    expect(chainIdOf(result.binding.assetId)).toBe(PAYOUT_CHAIN);
  });

  it('routes the MAINNET binding when that is the funded chain — the mirror case', async () => {
    // The mirror, and it is not decoration. The case above asserts only WHICH
    // binding won, so a router that derived ONE chain for the whole candidate
    // set — the first binding's, say — passes it: the devnet binding is asked
    // about, is funded, and wins, while the mainnet one is silently
    // `STAKE_UNKNOWN` for want of ever being asked. Swapping the amounts makes
    // that router route NOTHING, because the only binding it asked about is now
    // the under-funded one.
    const { router, mainnetBinding } = twoChainRouter(usdc(1), mainnetUsdc(1000));

    const result = await router.route(call);

    expect(result.binding.id).toBe(mainnetBinding.id);
    expect(chainIdOf(result.binding.assetId)).toBe(MAINNET);
  });

  it('says WHY each binding lost, and never STAKE_UNKNOWN for a chain it read', async () => {
    // The half the two cases above cannot state: a reading was obtained for
    // BOTH chains. With both below their own chain's floor nothing routes, and
    // the receipt names two shortfalls — `STAKE_BELOW_MINIMUM` twice.
    //
    // A router that asked about one chain for the whole set would report one
    // shortfall and one `STAKE_UNKNOWN`, which reads as "our source is down"
    // for a chain that was simply never asked about. That is the difference
    // between a provider being told to top up and a provider being told
    // nothing, and it is the only assertion here that fails on it.
    const { router } = twoChainRouter(usdc(1), mainnetUsdc(1));

    const error = await router
      .route(call)
      .then(() => null)
      .catch((e: AppError) => e);

    expect(error?.errorCode).toBe(ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING);
    expect(error?.message).toContain(`2 ${IneligibilityReason.STAKE_BELOW_MINIMUM}`);
    expect(error?.message).not.toContain(IneligibilityReason.STAKE_UNKNOWN);
  });
});
