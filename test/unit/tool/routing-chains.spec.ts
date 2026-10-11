import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  IneligibilityReason,
  RoutingContext,
  chooseSettlementChain,
  filterEligible,
  settleableChains,
} from '@modules/tool/domain/routing';
import { toToolBinding } from '@modules/tool/services/database-tool-catalogue';
import { BindingStatus } from '@modules/tool/ports/tool.types';

import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { AppError } from '@shared/errors/app-errors';
import { MoneyUtil } from '@utils/money.util';

import {
  MINIMUM_STAKE_BY_CHAIN,
  PAYOUT_ACCOUNT,
  RouterHarness,
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildCandidate,
  buildProvider,
  buildRouter,
  ok,
  usdc,
} from './helpers/routing-fixtures';

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const MAINNET = CHAIN_IDS.SOLANA_MAINNET;

/**
 * `tool_bindings.settlement_chains`.
 *
 * The binding is where "which chains is this tool OFFERED on" lives, and it is
 * config — the provider's own declaration. It is not, and must never be read
 * as, evidence that the provider is staked on those chains; that is the
 * write-time gate's job and the router's re-check, and they exist precisely because this
 * list cannot know.
 */
describe('ToolBinding.settlementChains', () => {
  const row = (over: Partial<ToolBindingEntity> = {}) =>
    ({
      id: 'b1',
      organizationId: 'p1',
      toolId: 'search_web',
      endpoint: 'https://p1.example.com/api',
      requestMapping: { method: 'POST' },
      responseMapping: {},
      pricingMode: 'PAID',
      priceAmount: '50000',
      assetId: ASSET_IDS.USDC_SOLANA_DEVNET,
      settlementChains: [DEVNET],
      freeQuotaPerAgent: null,
      freeDailyBudget: null,
      slaFailureRate: '0.02000',
      timeoutMs: 5000,
      status: 'ACTIVE',
      mappingVersion: 1,
      maxRps: null,
      maxDailyCalls: null,
      ...over,
    }) as unknown as ToolBindingEntity;

  it("carries the row's settlement_chains onto the domain type", () => {
    expect(toToolBinding(row()).settlementChains).toEqual([DEVNET]);
  });

  it('carries a two-chain list unchanged', () => {
    const chains = [DEVNET, 'eip155:46630'] as never;
    expect(toToolBinding(row({ settlementChains: chains })).settlementChains).toEqual(chains);
  });

  /**
   * A list that does NOT contain the chain `asset_id` names, and is returned
   * anyway.
   *
   * The two cases above are both satisfiable by a mapper that ignores the
   * column and derives `[chainIdOf(row.assetId)]` — the first trivially, the
   * second only if the derivation is *appended to*, which is exactly the kind
   * of half-measure a reviewer would wave through. Here the column and the
   * asset disagree, so a mapper that consults the asset at all answers
   * `[solana:EtWT…]` and fails.
   */
  it('returns a list that contradicts asset_id rather than correcting it', () => {
    const chains = ['eip155:46630'] as never;
    expect(toToolBinding(row({ settlementChains: chains })).settlementChains).toEqual([
      'eip155:46630',
    ]);
  });

  it('never synthesises a chain from asset_id at read time', () => {
    // The backfill derives from asset_id ONCE, in the migration. A mapper that
    // did it on every read would make the column unobservable: a provider who
    // disabled a chain would still route on it, and every test here would
    // still pass.
    const binding = toToolBinding(row({ settlementChains: [] as never }));
    expect(binding.settlementChains).toEqual([]);
  });

  /**
   * The `??` half of the same rule, which the empty-array case cannot reach.
   *
   * `[] ?? fallback` is `[]`, so a mapper written
   * `row.settlementChains ?? [chainIdOf(row.assetId)]` passes every case above
   * — the fallback never fires on an empty array. Handing it a row with no
   * value at all is the only input that fires it. The column is `NOT NULL` in
   * Postgres, so this row cannot come out of the database; the assertion is
   * about the mapper's honesty, not about a reachable state. `undefined` in,
   * `undefined` out: the mapper reports what the row said and invents nothing.
   */
  it('invents no list for a row that carries none', () => {
    const binding = toToolBinding(row({ settlementChains: undefined as never }));
    expect(binding.settlementChains).toBeUndefined();
  });
});

/**
 * The routing half: chain eligibility, settleable chains, chain choice, and the
 * router side of the per-binding settlement-chain list.
 *
 * `DEVNET` is the chain every default fixture is priced, paid and staked on;
 * `MAINNET` is a second chain nothing is configured for unless the case says
 * so. `MINIMUM_STAKE_BY_CHAIN` carries a floor for `DEVNET` alone, which is
 * this deployment's real shape — so a case that wants a candidate to reach the
 * stake gate on mainnet has to say so.
 */
describe('the router re-checks rather than trusting the binding list', () => {
  const both: RoutingContext = {
    payerChains: [DEVNET, MAINNET],
    enabledChains: [DEVNET, MAINNET],
    defaultChainId: DEVNET,
    withdrawingChains: [],
  };

  /**
   * The floor on BOTH chains, so a mainnet candidate is refused for its stake
   * rather than for a missing floor.
   *
   * One asset's floor under two chains is not the production shape — a floor's
   * `Money.asset` is CAIP-19 and names its own chain — and it is what this case
   * needs: with a real mainnet floor in mainnet USDC, a binding priced in
   * devnet USDC is refused with `STAKE_ASSET_MISMATCH` before any number is
   * compared, and the case would go green having proved nothing about stake.
   */
  const FLOOR_ON_BOTH = new Map([
    [DEVNET, MINIMUM_STAKE_BY_CHAIN.get(DEVNET)],
    [MAINNET, MINIMUM_STAKE_BY_CHAIN.get(DEVNET)],
  ]) as typeof MINIMUM_STAKE_BY_CHAIN;

  /**
   * THIS IS THE TEST THAT FAILS IF THE ROUTER STARTS TRUSTING THE CACHED LIST.
   *
   * The binding says it is offered on both chains — a true statement about the
   * provider's declaration, and it was true when the write-time gate passed it.
   * Since then the provider unstaked on mainnet. The rule: *"A binding
   * listing a chain whose stake has since been withdrawn or slashed to zero is
   * exactly the case where a call gets served with no collateral behind it,
   * which is the failure the whole staking design exists to prevent."*
   *
   * A router that read `binding.settlementChains` and stopped there passes
   * every other test in this file.
   */
  it('drops a chain the binding lists but the provider is no longer staked on', () => {
    const candidate = buildCandidate('p', {
      binding: { settlementChains: [DEVNET, MAINNET] },
      settlementChains: [DEVNET, MAINNET],
      stakeByChain: new Map([
        [DEVNET, { providerId: 'p', chainId: DEVNET, staked: usdc(1000), observedAt: new Date(0) }],
        [MAINNET, { providerId: 'p', chainId: MAINNET, staked: usdc(0), observedAt: new Date(0) }],
      ]),
      provider: {
        payoutAccountByChain: new Map([
          [DEVNET, PAYOUT_ACCOUNT],
          [MAINNET, PAYOUT_ACCOUNT],
        ]),
      },
    });

    // A buyer who can ONLY pay on mainnet gets nothing from this provider.
    const mainnetOnly = filterEligible([candidate], FLOOR_ON_BOTH, {
      ...both,
      payerChains: [MAINNET],
      defaultChainId: MAINNET,
      withdrawingChains: [],
    });

    expect(mainnetOnly.eligible).toHaveLength(0);
    expect(mainnetOnly.rejected[0].reason).toBe(IneligibilityReason.STAKE_BELOW_MINIMUM);

    // …and the SAME candidate is still routable for a devnet buyer. Unstaking
    // on one chain stops routing there and nowhere else.
    const devnetOnly = filterEligible([candidate], FLOOR_ON_BOTH, {
      ...both,
      payerChains: [DEVNET],
      defaultChainId: DEVNET,
      withdrawingChains: [],
    });

    expect(devnetOnly.eligible).toHaveLength(1);
    expect(devnetOnly.settlementChainOf.get(candidate.binding.id)).toBe(DEVNET);
  });

  it('reports the shortfall as STAKE_BELOW_MINIMUM, not CHAIN_NOT_SETTLEABLE', () => {
    // The two must not be conflated in either direction. CHAIN_NOT_SETTLEABLE
    // is a BUYER-side fact the provider cannot fix and must never see in their
    // console; a stake shortfall is a provider-side fact they fix in minutes.
    // Folding the stake re-check into `settlementChains` would relabel every
    // shortfall as a buyer problem and hide it from the person who can fix it.
    const candidate = buildCandidate('p', {
      settlementChains: [DEVNET],
      stakeByChain: new Map([
        [DEVNET, { providerId: 'p', chainId: DEVNET, staked: usdc(1), observedAt: new Date(0) }],
      ]),
    });

    const { rejected } = filterEligible([candidate], MINIMUM_STAKE_BY_CHAIN, {
      ...both,
      payerChains: [DEVNET],
    });

    expect(rejected[0].reason).toBe(IneligibilityReason.STAKE_BELOW_MINIMUM);
  });

  it("runs BOTH gates on the chosen chain, not on the candidate's first one", () => {
    // The candidate offers devnet first and mainnet second; the provider is
    // proved and bonded on MAINNET alone; the buyer's default is mainnet.
    //
    // A `filterEligible` that computed `settleable` and `chooseSettlementChain`
    // correctly, and then handed `candidate.settlementChains[0]` to the payout
    // and stake gates — the chosen chain appearing only in `settlementChainOf`
    // or in a message — refuses this candidate as PAYOUT_ACCOUNT_UNPROVED on
    // devnet. That is a provider-shaped rejection for a provider who did
    // everything right, and it is the shape a reviewer waves through because
    // the chain-selection code beside it is correct.
    const candidate = buildCandidate('p', {
      binding: { settlementChains: [DEVNET, MAINNET] },
      settlementChains: [DEVNET, MAINNET],
      provider: { payoutAccountByChain: new Map([[MAINNET, PAYOUT_ACCOUNT]]) },
      stakeByChain: new Map([
        [
          MAINNET,
          { providerId: 'p', chainId: MAINNET, staked: usdc(1000), observedAt: new Date(0) },
        ],
      ]),
    });

    const { eligible, rejected, settlementChainOf } = filterEligible([candidate], FLOOR_ON_BOTH, {
      ...both,
      defaultChainId: MAINNET,
      withdrawingChains: [],
    });

    expect(rejected).toEqual([]);
    expect(eligible).toHaveLength(1);
    expect(settlementChainOf.get(candidate.binding.id)).toBe(MAINNET);
  });

  it("gates on the CANDIDATE's chains, not the binding's own declaration", () => {
    // The narrowing put on the candidate: the binding declares
    // two chains and the provider holds an ACTIVE enrolment on one. A gate
    // reading `candidate.binding.settlementChains` would find mainnet in the
    // list, choose it (the buyer's default), and route a call to a provider
    // with no enrolment there — the payout gate would then refuse it as a
    // PROVIDER problem, which it is not.
    const candidate = buildCandidate('p', {
      binding: { settlementChains: [DEVNET, MAINNET] },
      settlementChains: [DEVNET],
      provider: {
        payoutAccountByChain: new Map([[DEVNET, PAYOUT_ACCOUNT]]),
      },
    });

    const { eligible, settlementChainOf } = filterEligible([candidate], MINIMUM_STAKE_BY_CHAIN, {
      ...both,
      defaultChainId: MAINNET,
      withdrawingChains: [],
    });

    expect(eligible).toHaveLength(1);
    expect(settlementChainOf.get(candidate.binding.id)).toBe(DEVNET);
  });
});

describe('CHAIN_NOT_SETTLEABLE', () => {
  it('rejects a candidate whose chains the buyer cannot pay on', () => {
    const candidate = buildCandidate('p', { settlementChains: [MAINNET] });

    const { rejected } = filterEligible([candidate], MINIMUM_STAKE_BY_CHAIN, {
      payerChains: [DEVNET],
      enabledChains: [DEVNET, MAINNET],
      defaultChainId: DEVNET,
      withdrawingChains: [],
    });

    expect(rejected[0].reason).toBe(IneligibilityReason.CHAIN_NOT_SETTLEABLE);
    expect(rejected[0].detail).toContain(MAINNET);
    expect(rejected[0].detail).toContain(DEVNET);
  });

  it('rejects a chain that ENABLED_CHAINS does not name, even when both parties have it', () => {
    // The enabled set narrows everything, and `filterEligible` is one of
    // the two seams that must read it BY NAME because it enumerates rather than
    // resolves.
    const candidate = buildCandidate('p', { settlementChains: [MAINNET] });

    const { rejected } = filterEligible([candidate], MINIMUM_STAKE_BY_CHAIN, {
      payerChains: [MAINNET],
      enabledChains: [DEVNET],
      defaultChainId: DEVNET,
      withdrawingChains: [],
    });

    expect(rejected[0].reason).toBe(IneligibilityReason.CHAIN_NOT_SETTLEABLE);
  });

  it('is reported before BINDING_NOT_ACTIVE', () => {
    // A buyer who could never have paid this provider must not be told about
    // the provider's draft binding — that is a provider-shaped signal about a
    // buyer-side condition, and it lands in the provider's console as a
    // rejection they are expected to fix.
    const candidate = buildCandidate('p', {
      binding: { status: BindingStatus.DRAFT },
      settlementChains: [MAINNET],
    });

    const { rejected } = filterEligible([candidate], MINIMUM_STAKE_BY_CHAIN, {
      payerChains: [DEVNET],
      enabledChains: [DEVNET, MAINNET],
      defaultChainId: DEVNET,
      withdrawingChains: [],
    });

    expect(rejected[0].reason).toBe(IneligibilityReason.CHAIN_NOT_SETTLEABLE);
  });

  it('is reported AFTER PROVIDER_EXCLUDED', () => {
    const candidate = buildCandidate('p', { settlementChains: [MAINNET] });

    const { rejected } = filterEligible([candidate], MINIMUM_STAKE_BY_CHAIN, {
      excludeProviderIds: ['p'],
      payerChains: [DEVNET],
      enabledChains: [DEVNET, MAINNET],
      defaultChainId: DEVNET,
      withdrawingChains: [],
    });

    expect(rejected[0].reason).toBe(IneligibilityReason.PROVIDER_EXCLUDED);
  });

  it('records no settlement chain for a candidate it rejected', () => {
    // `settlementChainOf` is what the caller stamps on the intent. An entry for
    // a candidate that never became eligible would be a chain nobody routed on
    // sitting in the record a dispute replays.
    const candidate = buildCandidate('p', { settlementChains: [MAINNET] });

    const { settlementChainOf } = filterEligible([candidate], MINIMUM_STAKE_BY_CHAIN, {
      payerChains: [DEVNET],
      enabledChains: [DEVNET, MAINNET],
      defaultChainId: DEVNET,
      withdrawingChains: [],
    });

    expect(settlementChainOf.size).toBe(0);
  });
});

describe('settleableChains', () => {
  const candidate = buildCandidate('p', { settlementChains: [DEVNET, MAINNET] });

  it('is the intersection of all THREE sets', () => {
    expect(
      settleableChains(candidate, {
        payerChains: [DEVNET, MAINNET],
        enabledChains: [MAINNET],
        defaultChainId: null,
        withdrawingChains: [],
      }),
    ).toEqual([MAINNET]);

    expect(
      settleableChains(candidate, {
        payerChains: [DEVNET],
        enabledChains: [DEVNET, MAINNET],
        defaultChainId: null,
        withdrawingChains: [],
      }),
    ).toEqual([DEVNET]);

    expect(
      settleableChains(buildCandidate('p', { settlementChains: [DEVNET] }), {
        payerChains: [DEVNET, MAINNET],
        enabledChains: [DEVNET, MAINNET],
        defaultChainId: null,
        withdrawingChains: [],
      }),
    ).toEqual([DEVNET]);
  });

  it("comes out in the BUYER's preference order, not the provider's", () => {
    // `accepts[]` and the chosen chain are both read off this, and a buyer who
    // lists mainnet first is saying something. Ordering by the candidate's list
    // would answer with the provider's preference instead — invisible while the
    // two happen to agree.
    expect(
      settleableChains(candidate, {
        payerChains: [MAINNET, DEVNET],
        enabledChains: [DEVNET, MAINNET],
        defaultChainId: null,
        withdrawingChains: [],
      }),
    ).toEqual([MAINNET, DEVNET]);
  });
});

describe('chooseSettlementChain', () => {
  it("prefers the buyer's default chain when it is settleable — rule 1", () => {
    // Rule 1 exists so the common case is stable: a buyer who funds one chain
    // and occasionally tops up the other does not get their traffic silently
    // migrated by a balance fluctuation.
    expect(chooseSettlementChain([MAINNET, DEVNET], DEVNET, [MAINNET, DEVNET])).toBe(DEVNET);
  });

  it('falls back to registration order when the default is not settleable — rule 3', () => {
    expect(chooseSettlementChain([MAINNET, DEVNET], null, [DEVNET, MAINNET])).toBe(DEVNET);
  });

  it('ignores a default the buyer cannot actually settle on', () => {
    // The half rule 1 alone does not pin: an implementation that returned
    // `defaultChainId` unconditionally passes the first case and would hand
    // back a chain that was excluded three lines earlier.
    expect(chooseSettlementChain([MAINNET], DEVNET, [DEVNET, MAINNET])).toBe(MAINNET);
  });

  it('is deterministic — a disputed call replays it from recorded inputs', () => {
    const first = chooseSettlementChain([MAINNET, DEVNET], null, [DEVNET, MAINNET]);
    const again = chooseSettlementChain([DEVNET, MAINNET], null, [DEVNET, MAINNET]);
    expect(again).toBe(first);
  });

  it('throws on an empty settleable set rather than returning a chain', () => {
    // The caller must have refused before reaching here. Returning something
    // would produce a settlement chain nobody chose.
    expect(() => chooseSettlementChain([], DEVNET, [DEVNET])).toThrow();
  });
});

describe('PAYMENT_NO_SETTLEABLE_CHAIN', () => {
  const routeWith = async (harness: RouterHarness, context: RoutingContext) =>
    harness.router
      .route({ toolId: TOOL_ID, callId: 'call-1', input: { query: 'x' }, context })
      .then(() => null)
      .catch((e: AppError) => e);

  /**
   * A provider offered and enrolled on MAINNET alone, bonded there.
   *
   * `MINIMUM_STAKE_BY_CHAIN` carries a floor for DEVNET only, so a mainnet
   * candidate that reached the stake gate would be refused `STAKE_UNKNOWN` —
   * which would make the "every candidate was chain-rejected" branch
   * unreachable and this whole describe vacuous. Each case that needs the stake
   * gate reached says so with `FLOOR_ON_BOTH`.
   */
  const mainnetOnly = (config?: Partial<Parameters<typeof buildRouter>[0]['config']>) =>
    buildRouter({
      bindings: [buildBinding('a', { settlementChains: [MAINNET] })],
      providers: [
        buildProvider('a', { payoutAccountByChain: new Map([[MAINNET, PAYOUT_ACCOUNT]]) }),
      ],
      stakes: {},
      stakesByChain: { [`a|${MAINNET}`]: usdc(1000) },
      enrolments: [{ providerId: 'a', chainId: MAINNET }],
      invoker: new ScriptedInvoker({}),
      config: config as never,
    });

  const DEVNET_BUYER: RoutingContext = {
    payerChains: [DEVNET],
    enabledChains: [DEVNET, MAINNET],
    defaultChainId: DEVNET,
    withdrawingChains: [],
  };

  it('is thrown, not TOOL_NO_ELIGIBLE_BINDING, when every candidate was chain-rejected', async () => {
    // End to end. Not 402 (nothing to pay), not 503 (nothing is broken),
    // not PAYMENT_INSUFFICIENT_FUNDS (the money is fine, it is in the wrong
    // place).
    const harness = mainnetOnly();

    const error = await routeWith(harness, DEVNET_BUYER);

    expect(error?.errorCode).toBe(PaymentErrorCode.PAYMENT_NO_SETTLEABLE_CHAIN);
    expect(error?.context).toMatchObject({
      tool: TOOL_ID,
      buyerChains: [DEVNET],
      toolChains: [MAINNET],
    });
  });

  it('carries the price so the SDK can tell the buyer how much to fund', async () => {
    // The error's context is { tool, buyerChains, toolChains, priceMinor, decimals }.
    // Without the price the one useful action — fund the other chain — needs a
    // second round trip to find out how much.
    const harness = mainnetOnly();

    const error = await routeWith(harness, DEVNET_BUYER);

    expect(error?.context).toMatchObject({ priceMinor: usdc('0.05').amount, decimals: 6 });
  });

  it('never dials a provider it chain-rejected, so no quality event is produced', async () => {
    // The corollary that nothing else in this tree enforces:
    // `CHAIN_NOT_SETTLEABLE` is never a provider-quality event, never counts
    // toward a circuit breaker and never enters `ProviderStats`.
    //
    // Nothing in this codebase reads an `Ineligible` into statistics today —
    // `IneligibilityReason` is consumed only inside `domain/routing/` and by
    // the router's own error text — so the invariant holds by MECHANISM rather
    // than by a filter: statistics, the breaker and `tool_call_records` are all
    // fed from ATTEMPTS, and a chain-rejected candidate is never attempted.
    // Asserting it here means a future consumer that starts folding rejections
    // into a provider's record breaks a test rather than a comment.
    const invoker = new ScriptedInvoker({});
    const harness = buildRouter({
      bindings: [buildBinding('a', { settlementChains: [MAINNET] })],
      providers: [
        buildProvider('a', { payoutAccountByChain: new Map([[MAINNET, PAYOUT_ACCOUNT]]) }),
      ],
      stakes: {},
      stakesByChain: { [`a|${MAINNET}`]: usdc(1000) },
      enrolments: [{ providerId: 'a', chainId: MAINNET }],
      invoker,
    });

    const error = await routeWith(harness, DEVNET_BUYER);

    expect(error?.errorCode).toBe(PaymentErrorCode.PAYMENT_NO_SETTLEABLE_CHAIN);
    expect(invoker.invocations).toHaveLength(0);
    // And no ceiling token was taken. Shedding debits a provider's declared
    // allowance, and a buyer on the wrong chain must not spend it.
    expect(harness.redis.commands).toEqual([]);
  });

  it('does NOT fire when some candidates were rejected for other reasons', async () => {
    // This error fires only when EVERY candidate was rejected for chain.
    // A provider whose binding is merely DRAFT is a different failure and must
    // keep its own name, or a buyer is sent to fund a chain that would not have
    // helped.
    const harness = buildRouter({
      bindings: [
        buildBinding('a', { settlementChains: [MAINNET] }),
        buildBinding('b', { status: BindingStatus.DRAFT, settlementChains: [DEVNET] }),
      ],
      providers: [
        buildProvider('a', { payoutAccountByChain: new Map([[MAINNET, PAYOUT_ACCOUNT]]) }),
        buildProvider('b'),
      ],
      stakes: { b: usdc(1000) },
      stakesByChain: { [`a|${MAINNET}`]: usdc(1000) },
      enrolments: [
        { providerId: 'a', chainId: MAINNET },
        { providerId: 'b', chainId: DEVNET },
      ],
      invoker: new ScriptedInvoker({}),
    });

    const error = await routeWith(harness, DEVNET_BUYER);

    expect(error?.errorCode).toBe(ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING);
  });

  it('records the chosen settlement chain on the routed call', async () => {
    const harness = buildRouter({
      bindings: [buildBinding('a', { settlementChains: [DEVNET, MAINNET] })],
      providers: [
        buildProvider('a', {
          payoutAccountByChain: new Map([
            [DEVNET, PAYOUT_ACCOUNT],
            [MAINNET, PAYOUT_ACCOUNT],
          ]),
        }),
      ],
      stakes: { a: usdc(1000) },
      stakesByChain: { [`a|${MAINNET}`]: usdc(1000) },
      enrolments: [
        { providerId: 'a', chainId: DEVNET },
        { providerId: 'a', chainId: MAINNET },
      ],
      invoker: new ScriptedInvoker({ 'binding-a': async () => ok() }),
      config: {
        minimumStakeByChain: new Map([
          [DEVNET, MINIMUM_STAKE_BY_CHAIN.get(DEVNET)],
          [MAINNET, MINIMUM_STAKE_BY_CHAIN.get(DEVNET)],
        ]) as never,
      },
    });

    const routed = await harness.router.route({
      toolId: TOOL_ID,
      callId: 'call-1',
      input: { query: 'x' },
      context: {
        payerChains: [MAINNET, DEVNET],
        enabledChains: [DEVNET, MAINNET],
        defaultChainId: MAINNET,
        withdrawingChains: [],
      },
    });

    // Rule 1: the buyer's default wins when it is settleable.
    expect(routed.settlementChain).toBe(MAINNET);
  });

  it('drops a chain the binding lists but the provider is not enrolled on', async () => {
    // The narrowing, through the SERVICE rather than through a hand-built
    // candidate. The binding declares both chains and the enrolment table says
    // devnet only, so a buyer who can pay only on mainnet is told
    // PAYMENT_NO_SETTLEABLE_CHAIN — and the `toolChains` it reports are the
    // NARROWED ones, not the binding's declaration, because telling a buyer to
    // fund a chain this provider is not on would be a wrong instruction.
    const harness = buildRouter({
      bindings: [buildBinding('a', { settlementChains: [DEVNET, MAINNET] })],
      providers: [buildProvider('a')],
      stakes: { a: usdc(1000) },
      enrolments: [{ providerId: 'a', chainId: DEVNET }],
      invoker: new ScriptedInvoker({}),
    });

    const error = await routeWith(harness, {
      payerChains: [MAINNET],
      enabledChains: [DEVNET, MAINNET],
      defaultChainId: MAINNET,
      withdrawingChains: [],
    });

    expect(error?.errorCode).toBe(PaymentErrorCode.PAYMENT_NO_SETTLEABLE_CHAIN);
    expect(error?.context).toMatchObject({ toolChains: [DEVNET] });
  });
});

describe('quote reports chains rather than hiding tools', () => {
  it('names every chain the tool is routable on', async () => {
    const harness = buildRouter({
      bindings: [
        buildBinding('a', { settlementChains: [DEVNET] }),
        buildBinding('b', { settlementChains: [MAINNET] }),
      ],
      providers: [
        buildProvider('a'),
        buildProvider('b', { payoutAccountByChain: new Map([[MAINNET, PAYOUT_ACCOUNT]]) }),
      ],
      stakes: { a: usdc(1000) },
      stakesByChain: { [`b|${MAINNET}`]: usdc(1000) },
      enrolments: [
        { providerId: 'a', chainId: DEVNET },
        { providerId: 'b', chainId: MAINNET },
      ],
      invoker: new ScriptedInvoker({}),
      config: {
        minimumStakeByChain: new Map([
          [DEVNET, MINIMUM_STAKE_BY_CHAIN.get(DEVNET)],
          [MAINNET, MINIMUM_STAKE_BY_CHAIN.get(DEVNET)],
        ]) as never,
      },
    });

    const quote = await harness.router.quote(TOOL_ID, {
      payerChains: [DEVNET, MAINNET],
      enabledChains: [DEVNET, MAINNET],
      defaultChainId: null,
      withdrawingChains: [],
    });

    expect([...(quote?.settlementChains ?? [])].sort()).toEqual([DEVNET, MAINNET].sort());
  });

  it('still prices a tool the buyer cannot pay for, rather than hiding it', async () => {
    // Hiding it makes the platform look like it lacks the tool. The
    // caller passes `payerChains: enabledChains` precisely so the catalogue can
    // SHOW the row and mark it "settles elsewhere"; a quote narrowed to the
    // buyer's own chain would return `routableBindings: 0` and the tool would
    // vanish from `tools/list`.
    const harness = buildRouter({
      bindings: [buildBinding('a', { settlementChains: [MAINNET] })],
      providers: [
        buildProvider('a', { payoutAccountByChain: new Map([[MAINNET, PAYOUT_ACCOUNT]]) }),
      ],
      stakes: {},
      stakesByChain: { [`a|${MAINNET}`]: usdc(1000) },
      enrolments: [{ providerId: 'a', chainId: MAINNET }],
      invoker: new ScriptedInvoker({}),
      config: {
        minimumStakeByChain: new Map([
          [DEVNET, MINIMUM_STAKE_BY_CHAIN.get(DEVNET)],
          [MAINNET, MINIMUM_STAKE_BY_CHAIN.get(DEVNET)],
        ]) as never,
      },
    });

    const quote = await harness.router.quote(TOOL_ID, {
      payerChains: [DEVNET, MAINNET],
      enabledChains: [DEVNET, MAINNET],
      defaultChainId: DEVNET,
      withdrawingChains: [],
    });

    expect(quote?.routableBindings).toBe(1);
    expect(quote?.price).not.toBeNull();
    expect(quote?.settlementChains).toEqual([MAINNET]);
  });

  it('names only the chains the provider is actually enrolled on', async () => {
    // The binding DECLARES two chains and its provider holds an ACTIVE
    // enrolment on one. A quote that echoed the declaration would put "settles
    // on Robinhood Chain" on the catalogue card for a provider who is not
    // there — sending the reader to fund a chain that will never route them.
    //
    // This is the case a `settlementChains` built from
    // `candidate.binding.settlementChains` passes every other test in this block on.
    const harness = buildRouter({
      bindings: [buildBinding('a', { settlementChains: [DEVNET, MAINNET] })],
      providers: [buildProvider('a')],
      stakes: { a: usdc(1000) },
      enrolments: [{ providerId: 'a', chainId: DEVNET }],
      invoker: new ScriptedInvoker({}),
    });

    const quote = await harness.router.quote(TOOL_ID, {
      payerChains: [DEVNET, MAINNET],
      enabledChains: [DEVNET, MAINNET],
      defaultChainId: null,
      withdrawingChains: [],
    });

    expect(quote?.settlementChains).toEqual([DEVNET]);
  });

  it('names no chain ENABLED_CHAINS does not carry', async () => {
    // The enabled set again, on the read path. A deployment that has switched a chain off
    // must not keep advertising it from a binding row that still lists it.
    const harness = buildRouter({
      bindings: [buildBinding('a', { settlementChains: [DEVNET, MAINNET] })],
      providers: [buildProvider('a')],
      stakes: { a: usdc(1000) },
      enrolments: [
        { providerId: 'a', chainId: DEVNET },
        { providerId: 'a', chainId: MAINNET },
      ],
      invoker: new ScriptedInvoker({}),
    });

    const quote = await harness.router.quote(TOOL_ID, {
      payerChains: [DEVNET, MAINNET],
      enabledChains: [DEVNET],
      defaultChainId: null,
      withdrawingChains: [],
    });

    expect(quote?.settlementChains).toEqual([DEVNET]);
  });
});

/**
 * One tool, two chains, two assets — the normal shape of a two-chain
 * marketplace (BUG-J-BUY-05).
 *
 * A Solana provider sells the tool in USDC and an EVM provider sells it in
 * USDG. Those two prices are not comparable and do not need to be: a buyer
 * pays on ONE chain, so it is quoted the price of the bindings that settle
 * there and routed among them. Throwing "priced in more than one asset" here
 * took `tools/list` down for every agent on the platform.
 */
describe('a tool sold on two chains in two assets', () => {
  const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;
  const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET!;
  const EVM_PAYOUT = `${EVM}:0x00000000000000000000000000000000000000aa` as never;
  const usdg = (atomic: string) => MoneyUtil.of(atomic, USDG, 6);

  const twoChains = () =>
    buildRouter({
      bindings: [
        // Solana devnet, USDC 0.25.
        buildBinding('sol', { priceAmount: '250000' }),
        // Robinhood testnet, USDG 0.10.
        buildBinding('evm', { priceAmount: '100000', assetId: USDG, settlementChains: [EVM] }),
      ],
      providers: [
        buildProvider('sol'),
        buildProvider('evm', { payoutAccountByChain: new Map([[EVM, EVM_PAYOUT]]) }),
      ],
      stakes: { sol: usdc(1000) },
      stakesByChain: { [`evm|${EVM}`]: usdg('1000000000') },
      invoker: new ScriptedInvoker({
        'binding-evm': async () => ok(),
        'binding-sol': async () => ok(),
      }),
      config: {
        // Each chain keeps its own floor, in its own asset.
        minimumStakeByChain: new Map([
          [DEVNET, MINIMUM_STAKE_BY_CHAIN.get(DEVNET)],
          [EVM, { floor: usdg('50000000'), priceMultiple: 1000 }],
        ]) as never,
      },
    });

  const buyerOn = (chainId: typeof DEVNET | typeof EVM | null): RoutingContext => ({
    payerChains: [DEVNET, EVM],
    enabledChains: [DEVNET, EVM],
    defaultChainId: chainId,
    withdrawingChains: [],
  });

  it('quotes an EVM buyer the USDG price of the EVM binding', async () => {
    const quote = await twoChains().router.quote(TOOL_ID, buyerOn(EVM));

    expect(quote?.price).toMatchObject({ amount: '100000', asset: USDG });
    expect([...(quote?.settlementChains ?? [])].sort()).toEqual([DEVNET, EVM].sort());
  });

  it('quotes a Solana buyer the USDC price of the Solana binding', async () => {
    const quote = await twoChains().router.quote(TOOL_ID, buyerOn(DEVNET));

    expect(quote?.price).toMatchObject({ amount: '250000', asset: ASSET_IDS.USDC_SOLANA_DEVNET });
    expect([...(quote?.settlementChains ?? [])].sort()).toEqual([DEVNET, EVM].sort());
  });

  it('quotes a buyer with no chain on the first enabled chain, not as an error', async () => {
    const quote = await twoChains().router.quote(TOOL_ID, buyerOn(null));

    expect(quote?.price).toMatchObject({ asset: ASSET_IDS.USDC_SOLANA_DEVNET });
  });

  it('routes an EVM buyer to the EVM binding and a Solana buyer to the Solana one', async () => {
    const harness = twoChains();
    const call = (chainId: typeof DEVNET | typeof EVM) =>
      harness.router.route({
        toolId: TOOL_ID,
        callId: `call-${chainId}`,
        input: { query: 'x' },
        context: { ...buyerOn(chainId), payerChains: [chainId] },
      });

    const evm = await call(EVM);
    expect(evm.binding.id).toBe('binding-evm');
    expect(evm.settlementChain).toBe(EVM);

    const sol = await call(DEVNET);
    expect(sol.binding.id).toBe('binding-sol');
    expect(sol.settlementChain).toBe(DEVNET);
  });
});
