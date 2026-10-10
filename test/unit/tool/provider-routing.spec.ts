import { AccountId, AssetId, chainIdOf } from '@modules/chains/ports/caip.types';
import { ProviderStatus, ProviderTier } from '@modules/provider/ports/provider.types';
import {
  ClassificationReason,
  ResponseClass,
} from '@modules/tool/domain/classification/classification.types';
import { MappingFault } from '@modules/tool/domain/mapping/mapping.types';
import {
  IneligibilityReason,
  MAX_PROVIDER_SHARE,
  computeWeights,
  evaluateStakeGate,
  filterEligible,
  minimumStakeFor,
  pickWeighted,
  scoreCandidates,
} from '@modules/tool/domain/routing';
import { ToolErrorCode, ToolErrors } from '@modules/tool/errors/tool.errors';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';
import { AppError } from '@shared/errors/app-errors';
import { MoneyUtil } from '@utils/money.util';

import {
  MINIMUM_STAKE,
  MINIMUM_STAKE_BY_CHAIN,
  PAYOUT_CHAIN,
  ROUTING_CONTEXT,
  routingContext,
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  anyChainContext,
  buildCandidate,
  buildProvider,
  buildRouter,
  hang,
  jsonResponse,
  ok,
  seededRandom,
  status,
  usdc,
} from './helpers/routing-fixtures';

/**
 * An asset on a chain nothing else in this file uses, and a payout address on
 * that same chain. The pair exists so a binding can be priced in something the
 * stake floor is not denominated in *without* also being unpayable — two
 * refusals in one fixture prove neither.
 */
const OTHER_ASSET = 'solana:mainnet/token:SomeOtherMint' as AssetId;
const OTHER_PAYOUT = 'solana:mainnet:SomeOtherPayoutWallet' as AccountId;
/** A second asset on {@link OTHER_ASSET}'s chain, so a floor there is a floor in the WRONG asset. */
const OTHER_FLOOR_ASSET = 'solana:mainnet/token:TheFloorMint' as AssetId;

/**
 * The router — timeout, failover, and the `stake >= minimumStake` gate.
 *
 * Six of these describe blocks are the router's acceptance list, and
 * one of them — "REQUEST_ERROR does not fail over" — is the one worth defending
 * in review. It is the only rule here that looks like a missing case rather
 * than a decision, and deleting it costs money on every malformed agent call
 * rather than failing a build.
 */
describe('ProviderRouterService', () => {
  const A = 'provider-a';
  const B = 'provider-b';
  const C = 'provider-c';

  const richStakes = { [A]: usdc(1000), [B]: usdc(1000), [C]: usdc(1000) };

  // -------------------------------------------------------------------------
  // 1. Timeout
  // -------------------------------------------------------------------------

  describe('timeout', () => {
    it('aborts an attempt at the binding timeout instead of waiting on it', async () => {
      const invoker = new ScriptedInvoker({ 'binding-provider-a': hang });
      const { router } = buildRouter({
        bindings: [buildBinding(A, { timeoutMs: 80 })],
        providers: [buildProvider(A)],
        stakes: richStakes,
        invoker,
        config: { maxAttempts: 1 },
      });

      const startedAt = Date.now();
      const error = await router
        .route({
          toolId: TOOL_ID,
          callId: 'test-call-id',
          input: { query: 'x' },
          context: ROUTING_CONTEXT,
        })
        .then(() => null)
        .catch((e: AppError) => e);
      const elapsed = Date.now() - startedAt;

      expect(error?.errorCode).toBe(ToolErrorCode.TOOL_ALL_BINDINGS_FAILED);
      // The threshold, from both sides: it did not give up early, and it did
      // not sit on a promise that never resolves.
      expect(elapsed).toBeGreaterThanOrEqual(75);
      expect(elapsed).toBeLessThan(1_000);
      expect(invoker.invocations[0].timeoutMs).toBe(80);
    });

    it('classifies a timeout as SYSTEM_ERROR with a transport reason', async () => {
      const invoker = new ScriptedInvoker({
        'binding-provider-a': hang,
        'binding-provider-b': async () => ok(),
      });
      const { router } = buildRouter({
        bindings: [buildBinding(A, { timeoutMs: 60 }), buildBinding(B)],
        providers: [buildProvider(A), buildProvider(B)],
        stakes: richStakes,
        invoker,
      });

      const result = await router.route({
        toolId: TOOL_ID,
        callId: 'test-call-id',
        input: { query: 'x' },
        context: ROUTING_CONTEXT,
      });

      expect(result.attempts[0].classification).toMatchObject({
        responseClass: ResponseClass.SYSTEM_ERROR,
        reason: ClassificationReason.TRANSPORT_TIMEOUT,
      });
      expect(result.attempts[0].elapsedMs).toBeGreaterThanOrEqual(55);
    });

    it('clips an attempt to what is left of the total deadline', async () => {
      const invoker = new ScriptedInvoker({ 'binding-provider-a': async () => ok() });
      const { router } = buildRouter({
        // The binding asks for 5s; the request as a whole only has 120ms.
        bindings: [buildBinding(A, { timeoutMs: 5_000 })],
        providers: [buildProvider(A)],
        stakes: richStakes,
        invoker,
        config: { totalDeadlineMs: 120 },
      });

      await router.route({
        toolId: TOOL_ID,
        callId: 'test-call-id',
        input: { query: 'x' },
        context: ROUTING_CONTEXT,
      });

      expect(invoker.invocations[0].timeoutMs).toBeLessThanOrEqual(120);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Failover on SYSTEM_ERROR
  // -------------------------------------------------------------------------

  describe('failover on SYSTEM_ERROR', () => {
    it('retries against a different provider and returns its result', async () => {
      const invoker = new ScriptedInvoker({
        'binding-provider-a': async () => status(503, { error: 'overloaded' }),
        'binding-provider-b': async () => ok('mapped-through'),
      });
      const { router } = buildRouter({
        bindings: [buildBinding(A), buildBinding(B)],
        providers: [buildProvider(A), buildProvider(B)],
        stakes: richStakes,
        invoker,
      });

      const result = await router.route({
        toolId: TOOL_ID,
        callId: 'test-call-id',
        input: { query: 'x' },
        context: ROUTING_CONTEXT,
      });

      expect(invoker.providerIds).toEqual([A, B]);
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0].classification.responseClass).toBe(ResponseClass.SYSTEM_ERROR);
      expect(result.providerId).toBe(B);
      expect(result.classification.responseClass).toBe(ResponseClass.DATA_RESULT);
      // The response arrived in the provider's shape and left in the tool's.
      expect(result.output).toEqual({ answer: 'mapped-through' });
    });

    it('never retries a second binding of the provider that just failed', async () => {
      const invoker = new ScriptedInvoker({
        'binding-a-1': async () => status(500),
        'binding-a-2': async () => status(500),
        'binding-provider-b': async () => ok(),
      });
      const { router } = buildRouter({
        bindings: [
          buildBinding(A, { id: 'binding-a-1' }),
          buildBinding(A, { id: 'binding-a-2' }),
          buildBinding(B),
        ],
        providers: [buildProvider(A), buildProvider(B)],
        stakes: richStakes,
        invoker,
      });

      const result = await router.route({
        toolId: TOOL_ID,
        callId: 'test-call-id',
        input: { query: 'x' },
        context: ROUTING_CONTEXT,
      });

      // Two bindings of one provider share an operator and a deployment.
      // Retrying the second is a retry against the thing that just failed.
      expect(invoker.bindingIds).toEqual(['binding-a-1', 'binding-provider-b']);
      expect(result.providerId).toBe(B);
    });

    it('fails over when our own mapping cannot read the response (PLATFORM fault)', async () => {
      const invoker = new ScriptedInvoker({
        // A 200 with a perfectly good body that our selector does not match.
        'binding-provider-a': async () => jsonResponse({ reply: 'wrong field name' }),
        'binding-provider-b': async () => ok(),
      });
      const { router } = buildRouter({
        bindings: [buildBinding(A), buildBinding(B)],
        providers: [buildProvider(A), buildProvider(B)],
        stakes: richStakes,
        invoker,
      });

      const result = await router.route({
        toolId: TOOL_ID,
        callId: 'test-call-id',
        input: { query: 'x' },
        context: ROUTING_CONTEXT,
      });

      // A mapping bug is ours. It must not read as provider garbage, and the
      // provider that *can* serve the call should still get it.
      expect(result.attempts[0].classification).toMatchObject({
        responseClass: ResponseClass.SYSTEM_ERROR,
        reason: ClassificationReason.MAPPING_FAULT_PLATFORM,
      });
      expect(result.providerId).toBe(B);
      expect(result.output).toEqual({ answer: 'forty-two' });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Failover exhausted
  // -------------------------------------------------------------------------

  describe('failover exhausted', () => {
    it('fails with TOOL_ALL_BINDINGS_FAILED once every provider is spent', async () => {
      const invoker = new ScriptedInvoker({
        'binding-provider-a': async () => status(500),
        'binding-provider-b': async () => status(502),
      });
      const { router } = buildRouter({
        bindings: [buildBinding(A), buildBinding(B)],
        providers: [buildProvider(A), buildProvider(B)],
        stakes: richStakes,
        invoker,
        config: { maxAttempts: 3 },
      });

      const error = await router
        .route({
          toolId: TOOL_ID,
          callId: 'test-call-id',
          input: { query: 'x' },
          context: ROUTING_CONTEXT,
        })
        .then(() => null)
        .catch((e: AppError) => e);

      expect(error).toBeInstanceOf(AppError);
      expect(error?.errorCode).toBe(ToolErrorCode.TOOL_ALL_BINDINGS_FAILED);
      expect(error?.statusCode).toBe(502);
      expect(error?.message).toContain('All 2 provider attempts failed');
      expect(error?.message).toContain('failover exhausted every remaining provider');
      // Each provider tried exactly once. No hanging, no loop.
      expect(invoker.providerIds).toEqual([A, B]);
      // The classified attempt is kept for the caller, so the voided intent can
      // say SYSTEM_ERROR and name what was tried rather than "never reached one".
      expect(error?.context?.lastAttempt).toEqual({
        bindingId: invoker.bindingIds[1],
        providerId: B,
        responseClass: 'SYSTEM_ERROR',
      });
    });

    it('stops at the attempt cap even when providers remain', async () => {
      const invoker = new ScriptedInvoker({
        'binding-provider-a': async () => status(500),
        'binding-provider-b': async () => status(500),
        'binding-provider-c': async () => status(500),
      });
      const { router } = buildRouter({
        bindings: [buildBinding(A), buildBinding(B), buildBinding(C)],
        providers: [buildProvider(A), buildProvider(B), buildProvider(C)],
        stakes: richStakes,
        invoker,
        config: { maxAttempts: 2 },
      });

      const error = await router
        .route({
          toolId: TOOL_ID,
          callId: 'test-call-id',
          input: { query: 'x' },
          context: ROUTING_CONTEXT,
        })
        .then(() => null)
        .catch((e: AppError) => e);

      expect(error?.errorCode).toBe(ToolErrorCode.TOOL_ALL_BINDINGS_FAILED);
      expect(error?.message).toContain('attempt cap of 2 reached');
      expect(invoker.invocations).toHaveLength(2);
    });

    it('distinguishes "nobody was routable" from "everybody failed"', async () => {
      const invoker = new ScriptedInvoker({});
      const { router } = buildRouter({
        bindings: [buildBinding(A, { status: BindingStatus.PAUSED })],
        providers: [buildProvider(A)],
        stakes: richStakes,
        invoker,
      });

      const error = await router
        .route({
          toolId: TOOL_ID,
          callId: 'test-call-id',
          input: { query: 'x' },
          context: ROUTING_CONTEXT,
        })
        .then(() => null)
        .catch((e: AppError) => e);

      // A catalogue gap and a multi-provider outage are different incidents.
      expect(error?.errorCode).toBe(ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING);
      expect(error?.statusCode).toBe(503);
      expect(error?.message).toContain(IneligibilityReason.BINDING_NOT_ACTIVE);
      expect(invoker.invocations).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. REQUEST_ERROR must NOT fail over — the mandatory one
  // -------------------------------------------------------------------------

  describe('REQUEST_ERROR does not fail over', () => {
    it('returns the rejection without touching a second provider', async () => {
      const invoker = new ScriptedInvoker({
        'binding-provider-a': async () => status(400, { error: 'query must not be empty' }),
        'binding-provider-b': async () => ok(),
      });
      const { router } = buildRouter({
        bindings: [buildBinding(A), buildBinding(B)],
        providers: [buildProvider(A), buildProvider(B)],
        stakes: richStakes,
        invoker,
      });

      const result = await router.route({
        toolId: TOOL_ID,
        callId: 'test-call-id',
        input: { query: 'x' },
        context: ROUTING_CONTEXT,
      });

      // The fault is in the arguments the agent sent. They arrive at the second
      // provider just as wrong, so a retry buys a second bill and the same
      // error — and drags a second provider's compatibility rate down with it.
      expect(invoker.providerIds).toEqual([A]);
      expect(result.attempts).toHaveLength(1);
      expect(result.classification.responseClass).toBe(ResponseClass.REQUEST_ERROR);
      expect(result.providerId).toBe(A);
      expect(result.output).toBeNull();
    });

    it('does not fail over on a mapping fault attributed to the agent', async () => {
      const invoker = new ScriptedInvoker({
        'binding-provider-a': () =>
          Promise.reject(
            ToolErrors.mappingRequiredFieldMissing({ field: 'query', fault: MappingFault.AGENT }),
          ),
        'binding-provider-b': async () => ok(),
      });
      const { router } = buildRouter({
        bindings: [buildBinding(A), buildBinding(B)],
        providers: [buildProvider(A), buildProvider(B)],
        stakes: richStakes,
        invoker,
      });

      const result = await router.route({
        toolId: TOOL_ID,
        callId: 'test-call-id',
        input: {},
        context: ROUTING_CONTEXT,
      });

      expect(invoker.providerIds).toEqual([A]);
      expect(result.classification).toMatchObject({
        responseClass: ResponseClass.REQUEST_ERROR,
        reason: ClassificationReason.MAPPING_FAULT_AGENT,
      });
    });

    it('returns a DATA_RESULT without failing over either', async () => {
      const invoker = new ScriptedInvoker({
        'binding-provider-a': async () => ok(),
        'binding-provider-b': async () => ok(),
      });
      const { router } = buildRouter({
        bindings: [buildBinding(A), buildBinding(B)],
        providers: [buildProvider(A), buildProvider(B)],
        stakes: richStakes,
        invoker,
      });

      const result = await router.route({
        toolId: TOOL_ID,
        callId: 'test-call-id',
        input: { query: 'x' },
        context: ROUTING_CONTEXT,
      });

      expect(invoker.invocations).toHaveLength(1);
      expect(result.classification.responseClass).toBe(ResponseClass.DATA_RESULT);
    });
  });

  // -------------------------------------------------------------------------
  // 5. The stake gate
  // -------------------------------------------------------------------------

  describe('stake gate', () => {
    it('routes past an under-staked provider to a staked one', async () => {
      const invoker = new ScriptedInvoker({
        'binding-provider-a': async () => ok('should never be called'),
        'binding-provider-b': async () => ok(),
      });
      const { router } = buildRouter({
        bindings: [buildBinding(A), buildBinding(B)],
        providers: [buildProvider(A), buildProvider(B)],
        // A is bonded at $10 against a $50 minimum; B is bonded at $1000.
        stakes: { [A]: usdc(10), [B]: usdc(1000) },
        invoker,
        random: seededRandom(7),
      });

      for (let call = 0; call < 200; call += 1) {
        const result = await router.route({
          toolId: TOOL_ID,
          callId: 'test-call-id',
          input: { query: 'x' },
          context: ROUTING_CONTEXT,
        });
        expect(result.providerId).toBe(B);
      }

      expect(invoker.providerIds.every((id) => id === B)).toBe(true);
    });

    it('refuses the call when the only provider is under-staked', async () => {
      const invoker = new ScriptedInvoker({});
      const { router } = buildRouter({
        bindings: [buildBinding(A)],
        providers: [buildProvider(A)],
        stakes: { [A]: usdc('49.999999') },
        invoker,
      });

      const error = await router
        .route({
          toolId: TOOL_ID,
          callId: 'test-call-id',
          input: { query: 'x' },
          context: ROUTING_CONTEXT,
        })
        .then(() => null)
        .catch((e: AppError) => e);

      expect(error?.errorCode).toBe(ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING);
      expect(error?.message).toContain(IneligibilityReason.STAKE_BELOW_MINIMUM);
      expect(invoker.invocations).toHaveLength(0);
    });

    it('admits a provider sitting exactly on the minimum', () => {
      const candidate = buildCandidate(A, { staked: usdc(50) });
      expect(evaluateStakeGate(candidate, PAYOUT_CHAIN, MINIMUM_STAKE).passed).toBe(true);
    });

    it('fails closed when the stake source has no answer', () => {
      const candidate = buildCandidate(A, { staked: null });
      const verdict = evaluateStakeGate(candidate, PAYOUT_CHAIN, MINIMUM_STAKE);

      // Absent is not zero, and neither is routable — but an operator reading
      // the receipt has to be able to tell "the source is down" from "they
      // never bonded".
      expect(verdict).toMatchObject({ passed: false, reason: IneligibilityReason.STAKE_UNKNOWN });
    });

    it('routes a FREE binding from an unbonded provider', () => {
      const candidate = buildCandidate(A, {
        binding: { pricingMode: PricingMode.FREE, priceAmount: '0' },
        staked: null,
      });

      // Nothing settles on a free call, so there is no defection to collateralise.
      expect(evaluateStakeGate(candidate, PAYOUT_CHAIN, MINIMUM_STAKE).passed).toBe(true);
    });

    it('gates a FREEMIUM binding like a paid one', () => {
      const candidate = buildCandidate(A, {
        binding: { pricingMode: PricingMode.FREEMIUM },
        staked: usdc(1),
      });

      // At selection time we cannot know whether this call falls inside the
      // free quota, and guessing permissively routes a paid call to an
      // unbonded provider.
      expect(evaluateStakeGate(candidate, PAYOUT_CHAIN, MINIMUM_STAKE).passed).toBe(false);
    });

    it('scales the minimum with the price', () => {
      // 1000 × $0.01 = $10, below the $50 floor → the floor wins.
      expect(minimumStakeFor(usdc('0.01'), MINIMUM_STAKE)).toEqual(usdc(50));
      // 1000 × $2 = $2000 → the multiple wins.
      expect(minimumStakeFor(usdc(2), MINIMUM_STAKE)).toEqual(usdc(2000));
    });

    it('honours a negotiated per-provider minimum', () => {
      const candidate = buildCandidate(A, {
        binding: { priceAmount: usdc(2).amount },
        provider: { minimumStakeOverride: usdc(100) },
        staked: usdc(150),
      });

      // The computed floor would be $2000; the contract says $100.
      expect(evaluateStakeGate(candidate, PAYOUT_CHAIN, MINIMUM_STAKE).passed).toBe(true);
    });

    it('refuses rather than converting when the assets differ', () => {
      const candidate = buildCandidate(A, {
        binding: { assetId: 'solana:mainnet/token:SomeOtherMint' as never },
      });

      expect(evaluateStakeGate(candidate, PAYOUT_CHAIN, MINIMUM_STAKE)).toMatchObject({
        passed: false,
        reason: IneligibilityReason.STAKE_ASSET_MISMATCH,
      });
    });
  });

  // -------------------------------------------------------------------------
  // 5b. The 7-day grace period, as the router applies it
  // -------------------------------------------------------------------------

  /**
   * `applyStakeGrace` has its own suite (`stake-grace.spec.ts`) and this one is
   * not a second copy of it. Everything here is about the **caller**: that the
   * router loads the grace row at all, that it re-examines only the candidates
   * the gate rejected for being short, and that `quote()` reaches the same
   * verdict as `route()` — because a quote that says "unavailable" while
   * routing serves the call is a disagreement nobody discovers until a provider
   * asks why.
   *
   * The stake floor throughout is $50 (the fixture's binding is $0.05 ×
   * 1000), so `usdc(10)` is short and `usdc(1000)` is not.
   */
  describe('grace period', () => {
    const IN_AN_HOUR = () => new Date(Date.now() + 60 * 60 * 1000);
    const AN_HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000);

    it('routes a below-minimum binding whose grace has not expired', async () => {
      const invoker = new ScriptedInvoker({ 'binding-provider-a': async () => ok() });
      const { router } = buildRouter({
        bindings: [buildBinding(A)],
        providers: [buildProvider(A)],
        // $10 against a $50 floor — the gate refuses this outright.
        stakes: { [A]: usdc(10) },
        graces: { 'binding-provider-a': IN_AN_HOUR() },
        invoker,
      });

      const result = await router.route({
        toolId: TOOL_ID,
        callId: 'test-call-id',
        input: { query: 'x' },
        context: ROUTING_CONTEXT,
      });

      // The provider is told: `Your traffic is still flowing.`
      expect(result.providerId).toBe(A);
      expect(invoker.invocations).toHaveLength(1);
    });

    it('refuses it once grace has expired, with STAKE_GRACE_EXPIRED', async () => {
      const invoker = new ScriptedInvoker({});
      const { router } = buildRouter({
        bindings: [buildBinding(A)],
        providers: [buildProvider(A)],
        stakes: { [A]: usdc(10) },
        // Open — the sweeper has not closed it yet — and past its deadline.
        // That window is exactly when the provider must be told the clock ran
        // out rather than being told about the shortfall as if it were new.
        graces: { 'binding-provider-a': AN_HOUR_AGO() },
        invoker,
      });

      const error = await router
        .route({
          toolId: TOOL_ID,
          callId: 'test-call-id',
          input: { query: 'x' },
          context: ROUTING_CONTEXT,
        })
        .then(() => null)
        .catch((e: AppError) => e);

      expect(error?.errorCode).toBe(ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING);
      expect(error?.message).toContain(IneligibilityReason.STAKE_GRACE_EXPIRED);
      expect(error?.message).not.toContain(IneligibilityReason.STAKE_BELOW_MINIMUM);
      expect(invoker.invocations).toHaveLength(0);
    });

    it('leaves a below-minimum binding with no grace row as STAKE_BELOW_MINIMUM', async () => {
      const invoker = new ScriptedInvoker({});
      const { router } = buildRouter({
        bindings: [buildBinding(A)],
        providers: [buildProvider(A)],
        stakes: { [A]: usdc(10) },
        // No row at all. Telling someone their grace expired when they never
        // had one is a lie in the receipt.
        invoker,
      });

      const error = await router
        .route({
          toolId: TOOL_ID,
          callId: 'test-call-id',
          input: { query: 'x' },
          context: ROUTING_CONTEXT,
        })
        .then(() => null)
        .catch((e: AppError) => e);

      expect(error?.message).toContain(IneligibilityReason.STAKE_BELOW_MINIMUM);
      expect(error?.message).not.toContain(IneligibilityReason.STAKE_GRACE_EXPIRED);
    });

    it('does not resurrect a candidate rejected for any other reason', async () => {
      const D = 'provider-d';
      const invoker = new ScriptedInvoker({});
      const { router } = buildRouter({
        bindings: [
          // STAKE_UNKNOWN — the source had no answer for A.
          buildBinding(A),
          // STAKE_ASSET_MISMATCH — priced in an asset the floor is not in.
          buildBinding(B, { assetId: OTHER_ASSET }),
          // PROVIDER_NOT_ACTIVE.
          buildBinding(C),
          // BINDING_NOT_ACTIVE — a circuit that opened.
          buildBinding(D, { status: BindingStatus.PAUSED }),
        ],
        providers: [
          buildProvider(A),
          // Proved ON THE CHAIN ITS BINDING IS PRICED IN. Without
          // this the payout gate — which runs BEFORE the stake gate — refuses B
          // for `PAYOUT_ACCOUNT_UNPROVED` and the asset mismatch this fixture
          // exists to produce is never reached. The rejection under test is the
          // stake gate's, so the provider has to get past the payout one.
          buildProvider(B, {
            payoutAccountByChain: new Map([[chainIdOf(OTHER_ASSET), OTHER_PAYOUT]]),
          }),
          buildProvider(C, { status: ProviderStatus.UNBONDING }),
          buildProvider(D),
        ],
        stakes: { [B]: usdc(1000), [C]: usdc(1000), [D]: usdc(1000) },
        // A floor for B's chain, denominated in a DIFFERENT asset on that same
        // chain. Without it B is refused for having no configured floor
        // at all, and the asset mismatch this fixture exists to produce is
        // never reached — the floor lookup now happens before the gate. With
        // it, the chain is configured and the refusal is the gate's own:
        // no FX, so a price and a floor in two assets cannot be compared.
        config: {
          minimumStakeByChain: new Map([
            [PAYOUT_CHAIN, MINIMUM_STAKE],
            [
              chainIdOf(OTHER_ASSET),
              {
                floor: MoneyUtil.of('50000000', OTHER_FLOOR_ASSET, 6),
                priceMultiple: 1000,
              },
            ],
          ]),
        },
        // Every one of them is inside an open, unexpired grace period, and none
        // of them may be routed to. Grace answers one question — "is this
        // provider a little short of their floor" — and none of these four is
        // that question.
        graces: {
          'binding-provider-a': IN_AN_HOUR(),
          'binding-provider-b': IN_AN_HOUR(),
          'binding-provider-c': IN_AN_HOUR(),
          'binding-provider-d': IN_AN_HOUR(),
        },
        invoker,
      });

      const error = await router
        .route({
          toolId: TOOL_ID,
          callId: 'test-call-id',
          input: { query: 'x' },
          // B is priced on a SECOND chain, so a buyer confined to the default
          // one would be told `CHAIN_NOT_SETTLEABLE` and the asset mismatch
          // this fixture exists to produce would never be reached. Each of the
          // four candidates must fail for its own declared reason.
          context: routingContext({
            payerChains: [PAYOUT_CHAIN, chainIdOf(OTHER_ASSET)],
            enabledChains: [PAYOUT_CHAIN, chainIdOf(OTHER_ASSET)],
          }),
        })
        .then(() => null)
        .catch((e: AppError) => e);

      expect(error?.errorCode).toBe(ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING);
      expect(error?.message).toContain(IneligibilityReason.STAKE_UNKNOWN);
      expect(error?.message).toContain(IneligibilityReason.STAKE_ASSET_MISMATCH);
      expect(error?.message).toContain(IneligibilityReason.PROVIDER_NOT_ACTIVE);
      expect(error?.message).toContain(IneligibilityReason.BINDING_NOT_ACTIVE);
      expect(invoker.invocations).toHaveLength(0);
    });

    it('quote sees the same grace decision as select()', async () => {
      const invoker = new ScriptedInvoker({ 'binding-provider-a': async () => ok() });

      const inside = buildRouter({
        bindings: [buildBinding(A)],
        providers: [buildProvider(A)],
        stakes: { [A]: usdc(10) },
        graces: { 'binding-provider-a': IN_AN_HOUR() },
        invoker,
      });

      const quotedInside = await inside.router.quote(TOOL_ID, ROUTING_CONTEXT);
      const routedInside = await inside.router.route({
        toolId: TOOL_ID,
        callId: 'test-call-id',
        input: { query: 'x' },
        context: ROUTING_CONTEXT,
      });

      // Routing serves it, so the quote must price it.
      expect(routedInside.providerId).toBe(A);
      expect(quotedInside?.routableBindings).toBe(1);
      expect(quotedInside?.price).toEqual(usdc('0.05'));
      expect(quotedInside?.unroutableReason).toBeNull();

      const expired = buildRouter({
        bindings: [buildBinding(A)],
        providers: [buildProvider(A)],
        stakes: { [A]: usdc(10) },
        graces: { 'binding-provider-a': AN_HOUR_AGO() },
        invoker: new ScriptedInvoker({}),
      });

      const quotedExpired = await expired.router.quote(TOOL_ID, ROUTING_CONTEXT);

      expect(quotedExpired?.routableBindings).toBe(0);
      expect(quotedExpired?.price).toBeNull();
      expect(quotedExpired?.unroutableReason).toContain(IneligibilityReason.STAKE_GRACE_EXPIRED);
    });

    it('loads stakeGraceUntil onto every candidate — not the hardcoded null', async () => {
      const invoker = new ScriptedInvoker({ 'binding-provider-b': async () => ok() });
      const { router, graceSource } = buildRouter({
        bindings: [buildBinding(A), buildBinding(B)],
        providers: [buildProvider(A), buildProvider(B)],
        // Both are short of the floor.
        stakes: { [A]: usdc(10), [B]: usdc(10) },
        // Only B has a row. If the loader keyed on anything but the binding —
        // or kept the placeholder — either both would route or neither would.
        graces: { 'binding-provider-b': IN_AN_HOUR() },
        invoker,
        random: seededRandom(11),
      });

      for (let call = 0; call < 25; call += 1) {
        const result = await router.route({
          toolId: TOOL_ID,
          callId: 'test-call-id',
          input: { query: 'x' },
          context: ROUTING_CONTEXT,
        });
        expect(result.providerId).toBe(B);
      }

      // Batched over the tool's bindings, and asked about both of them — not
      // about whichever one selection happened to reach.
      expect(graceSource.bindingIdsAsked.sort()).toEqual([
        'binding-provider-a',
        'binding-provider-b',
      ]);
      expect(graceSource.lookups[0]).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Eligibility beyond the stake gate
  // -------------------------------------------------------------------------

  describe('eligibility', () => {
    it('reports one reason per rejected candidate', () => {
      const candidates = [
        buildCandidate(A, { binding: { status: BindingStatus.PAUSED } }),
        buildCandidate(B, { provider: { status: ProviderStatus.UNBONDING } }),
        buildCandidate(C, { staked: usdc(1) }),
        buildCandidate('provider-d'),
      ];

      const { eligible, rejected } = filterEligible(candidates, MINIMUM_STAKE_BY_CHAIN, {
        ...anyChainContext(candidates),
        excludeProviderIds: ['provider-d'],
      });

      expect(eligible).toHaveLength(0);
      expect(rejected.map((r) => r.reason)).toEqual([
        IneligibilityReason.BINDING_NOT_ACTIVE,
        IneligibilityReason.PROVIDER_NOT_ACTIVE,
        IneligibilityReason.STAKE_BELOW_MINIMUM,
        IneligibilityReason.PROVIDER_EXCLUDED,
      ]);
    });

    it('refuses a binding whose provider the registry does not know', async () => {
      const invoker = new ScriptedInvoker({});
      const { router } = buildRouter({
        bindings: [buildBinding(A)],
        providers: [],
        stakes: richStakes,
        invoker,
      });

      const error = await router
        .route({
          toolId: TOOL_ID,
          callId: 'test-call-id',
          input: { query: 'x' },
          context: ROUTING_CONTEXT,
        })
        .then(() => null)
        .catch((e: AppError) => e);

      expect(error?.message).toContain(IneligibilityReason.PROVIDER_UNKNOWN);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Traffic distribution
  // -------------------------------------------------------------------------

  describe('traffic distribution', () => {
    const DRAWS = 20_000;

    it('samples in proportion to declared weights', () => {
      const weighted = [
        { candidate: buildCandidate(A), score: 0.6, weight: 0.6 },
        { candidate: buildCandidate(B), score: 0.3, weight: 0.3 },
        { candidate: buildCandidate(C), score: 0.1, weight: 0.1 },
      ];

      const random = seededRandom(1);
      const counts = new Map<string, number>();

      for (let draw = 0; draw < DRAWS; draw += 1) {
        const picked = pickWeighted(weighted, random);
        const id = picked!.candidate.binding.providerId;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }

      expect((counts.get(A) ?? 0) / DRAWS).toBeCloseTo(0.6, 2);
      expect((counts.get(B) ?? 0) / DRAWS).toBeCloseTo(0.3, 2);
      expect((counts.get(C) ?? 0) / DRAWS).toBeCloseTo(0.1, 2);
    });

    it('splits evenly between providers that score identically', async () => {
      const invoker = new ScriptedInvoker({
        'binding-provider-a': async () => ok(),
        'binding-provider-b': async () => ok(),
        'binding-provider-c': async () => ok(),
      });
      const { router } = buildRouter({
        bindings: [buildBinding(A), buildBinding(B), buildBinding(C)],
        providers: [buildProvider(A), buildProvider(B), buildProvider(C)],
        stakes: richStakes,
        invoker,
        random: seededRandom(42),
      });

      const CALLS = 3_000;
      for (let call = 0; call < CALLS; call += 1) {
        await router.route({
          toolId: TOOL_ID,
          callId: 'test-call-id',
          input: { query: 'x' },
          context: ROUTING_CONTEXT,
        });
      }

      for (const providerId of [A, B, C]) {
        const share = invoker.providerIds.filter((id) => id === providerId).length / CALLS;
        expect(share).toBeGreaterThan(0.3);
        expect(share).toBeLessThan(0.37);
      }
    });

    /** A dominates on every axis; B and C are barely alive. Argmax gives A 100%. */
    const dominantProviders = () => [
      buildProvider(A, {
        tier: ProviderTier.TRUSTED,
        stats: { availabilityRate: 1, paidQualityRate: 1, p95LatencyMs: 50 },
      }),
      buildProvider(B, {
        tier: ProviderTier.NEW,
        stats: { availabilityRate: 0.02, paidQualityRate: 0.02, p95LatencyMs: 5_000 },
      }),
      buildProvider(C, {
        tier: ProviderTier.NEW,
        stats: { availabilityRate: 0.02, paidQualityRate: 0.02, p95LatencyMs: 5_000 },
      }),
    ];

    it('declares no more than MAX_PROVIDER_SHARE for the best provider', () => {
      const [providerA, providerB, providerC] = dominantProviders();
      const weights = computeWeights(
        scoreCandidates([
          buildCandidate(A, { provider: providerA }),
          buildCandidate(B, { provider: providerB }),
          buildCandidate(C, { provider: providerC }),
        ]),
      );

      const share = (providerId: string) =>
        weights.find((w) => w.candidate.binding.providerId === providerId)!.weight;

      // Unclamped, A's score is ~75% of the total. The cap takes it to 60% and
      // hands the remainder to the two providers it beat — which is the whole
      // point: they stay measured and warm.
      expect(share(A)).toBeCloseTo(MAX_PROVIDER_SHARE, 9);
      expect(share(B)).toBeCloseTo(0.2, 9);
      expect(share(C)).toBeCloseTo(0.2, 9);
    });

    it('routes to that declared share over thousands of calls', async () => {
      const invoker = new ScriptedInvoker({
        'binding-provider-a': async () => ok(),
        'binding-provider-b': async () => ok(),
        'binding-provider-c': async () => ok(),
      });
      const { router } = buildRouter({
        bindings: [buildBinding(A), buildBinding(B), buildBinding(C)],
        providers: dominantProviders(),
        stakes: richStakes,
        invoker,
        random: seededRandom(99),
      });

      const CALLS = 3_000;
      for (let call = 0; call < CALLS; call += 1) {
        await router.route({
          toolId: TOOL_ID,
          callId: 'test-call-id',
          input: { query: 'x' },
          context: ROUTING_CONTEXT,
        });
      }

      const observed = (providerId: string) =>
        invoker.providerIds.filter((id) => id === providerId).length / CALLS;

      expect(observed(A)).toBeCloseTo(MAX_PROVIDER_SHARE, 1);
      expect(observed(A)).toBeLessThanOrEqual(MAX_PROVIDER_SHARE + 0.02);
      expect(observed(B)).toBeCloseTo(0.2, 1);
      expect(observed(C)).toBeCloseTo(0.2, 1);
    });

    it('counts a provider once however many bindings it publishes', () => {
      const scored = scoreCandidates([
        buildCandidate(A, { binding: { id: 'a-1' } }),
        buildCandidate(A, { binding: { id: 'a-2' } }),
        buildCandidate(A, { binding: { id: 'a-3' } }),
        buildCandidate(B),
      ]);

      const weights = computeWeights(scored);
      const shareOfA = weights
        .filter((w) => w.candidate.binding.providerId === A)
        .reduce((sum, w) => sum + w.weight, 0);

      // Otherwise the cap is circumvented by publishing duplicates.
      expect(shareOfA).toBeLessThanOrEqual(MAX_PROVIDER_SHARE + 1e-9);
      expect(weights.reduce((sum, w) => sum + w.weight, 0)).toBeCloseTo(1, 9);
    });

    it('gives a sole provider all of the traffic rather than 60%', () => {
      const weights = computeWeights(scoreCandidates([buildCandidate(A)]));

      // Shares have to sum to 1, so the cap yields. A tool with one provider is
      // a tool with no failover, and pretending otherwise would hide that.
      expect(weights[0].weight).toBeCloseTo(1, 9);
    });
  });

  // -------------------------------------------------------------------------
  // The AppError context that makes fault attribution readable
  // -------------------------------------------------------------------------

  describe('mapping fault attribution', () => {
    it('survives being thrown', () => {
      const error = ToolErrors.mappingPathNotFound({
        path: '$.answer',
        fault: MappingFault.PLATFORM,
      });

      // The mapping engine attaches `fault` to every mapping error so the
      // classifier can read it;
      // until `AppError` retained its context, nothing could.
      expect(error.context?.fault).toBe(MappingFault.PLATFORM);
    });
  });
});
