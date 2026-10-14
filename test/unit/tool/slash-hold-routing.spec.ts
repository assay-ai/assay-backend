import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { IneligibilityReason, RoutingContext, filterEligible } from '@modules/tool/domain/routing';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { AppError } from '@shared/errors/app-errors';

import {
  MINIMUM_STAKE_BY_CHAIN,
  PAYOUT_ACCOUNT,
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
const FLOOR_ON_BOTH = new Map([
  [DEVNET, MINIMUM_STAKE_BY_CHAIN.get(DEVNET)],
  [MAINNET, MINIMUM_STAKE_BY_CHAIN.get(DEVNET)],
]) as typeof MINIMUM_STAKE_BY_CHAIN;
const HOLD = (chainId: typeof DEVNET) => ({
  chainId,
  reasons: ['STAKE_FULLY_RESERVED'],
  heldSince: new Date(0),
});

/**
 * The provider slash hold, at routing: a held provider's paid bindings are not
 * routed or quoted on the held chain; another chain the buyer can pay on still
 * settles, another provider still serves, and a buyer with nobody left gets
 * TOOL_PROVIDER_SLASH_HOLD.
 */
describe('a provider on a slash hold is not routed on that chain', () => {
  const candidate = (holds: ReturnType<typeof HOLD>[], pricingMode?: PricingMode) =>
    buildCandidate('p', {
      binding: {
        settlementChains: [DEVNET, MAINNET],
        ...(pricingMode ? { pricingMode } : {}),
      },
      settlementChains: [DEVNET, MAINNET],
      stakeByChain: new Map([
        [DEVNET, { providerId: 'p', chainId: DEVNET, staked: usdc(1000), observedAt: new Date(0) }],
        [
          MAINNET,
          { providerId: 'p', chainId: MAINNET, staked: usdc(1000), observedAt: new Date(0) },
        ],
      ]),
      provider: {
        payoutAccountByChain: new Map([
          [DEVNET, PAYOUT_ACCOUNT],
          [MAINNET, PAYOUT_ACCOUNT],
        ]),
        slashHolds: holds,
      },
    });
  const context: RoutingContext = {
    payerChains: [DEVNET],
    enabledChains: [DEVNET, MAINNET],
    defaultChainId: DEVNET,
    withdrawingChains: [],
  };

  it('rejects with PROVIDER_SLASH_HOLD when the only payable chain is held', () => {
    const result = filterEligible([candidate([HOLD(DEVNET)])], FLOOR_ON_BOTH, context);
    expect(result.eligible).toHaveLength(0);
    expect(result.rejected[0].reason).toBe(IneligibilityReason.PROVIDER_SLASH_HOLD);
  });

  it('settles on another chain the buyer can pay on', () => {
    const both = { ...context, payerChains: [DEVNET, MAINNET] };
    const result = filterEligible([candidate([HOLD(DEVNET)])], FLOOR_ON_BOTH, both);
    expect(result.eligible).toHaveLength(1);
    expect([...result.settlementChainOf.values()]).toEqual([MAINNET]);
  });

  it('routes normally with no hold, and a FREE binding moves no money so is not held', () => {
    expect(filterEligible([candidate([])], FLOOR_ON_BOTH, context).eligible).toHaveLength(1);
    expect(
      filterEligible([candidate([HOLD(DEVNET)], PricingMode.FREE)], FLOOR_ON_BOTH, context)
        .eligible,
    ).toHaveLength(1);
  });

  const route = (providers: ReturnType<typeof buildProvider>[], invoker: ScriptedInvoker) =>
    buildRouter({
      bindings: providers.map((provider) =>
        buildBinding(provider.providerId, { settlementChains: [DEVNET] }),
      ),
      providers,
      stakes: {},
      stakesByChain: Object.fromEntries(
        providers.map((provider) => [`${provider.providerId}|${DEVNET}`, usdc(1000)]),
      ),
      enrolments: providers.map((provider) => ({
        providerId: provider.providerId,
        chainId: DEVNET,
      })),
      invoker,
    }).router.route({ toolId: TOOL_ID, callId: 'call-1', input: { query: 'x' }, context });

  it('routes the buyer to another provider of the tool', async () => {
    const invoker = new ScriptedInvoker({ 'binding-b': () => Promise.resolve(ok('answer')) });
    await route([buildProvider('a', { slashHolds: [HOLD(DEVNET)] }), buildProvider('b')], invoker);
    expect(invoker.invocations.map((call) => call.binding.providerId)).toEqual(['b']);
  });

  it('answers TOOL_PROVIDER_SLASH_HOLD when nobody else serves the tool', async () => {
    const invoker = new ScriptedInvoker({});
    const error: AppError | null = await route(
      [buildProvider('a', { slashHolds: [HOLD(DEVNET)] })],
      invoker,
    )
      .then(() => null)
      .catch((e: AppError) => e);
    expect(error?.errorCode).toBe(ToolErrorCode.TOOL_PROVIDER_SLASH_HOLD);
    expect(invoker.invocations).toHaveLength(0);
  });
});
