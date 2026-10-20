import { ProviderTier } from '@modules/provider/ports/provider.types';
import {
  OnEmpty,
  ProviderMode,
  RuleRejectionReason,
  RuleSource,
  RoutingRules,
  applyRules,
  evaluateRules,
  mergeRules,
  rejectionLayer,
  withoutEntryPreferences,
} from '@modules/tool/domain/routing';
import { ToolAccessErrorCode } from '@modules/tool/errors/tool-access.errors';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { MoneyUtil } from '@utils/money.util';

import {
  ROUTING_CONTEXT,
  STAKE_ASSET,
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildCandidate,
  buildProvider,
  buildRouter,
  buildTool,
  ok,
  usdc,
} from './helpers/routing-fixtures';

const AGENT = (over: Partial<NonNullable<RoutingRules['agent']>> = {}) => ({
  excludeProviderIds: [],
  maxPrice: null,
  minTier: null,
  minQuality: null,
  ...over,
});

const ENTRY = (over: Partial<NonNullable<RoutingRules['entry']>> = {}) => ({
  mode: ProviderMode.BEST,
  providerIds: [],
  minTier: null,
  maxPrice: null,
  minQuality: null,
  onEmpty: OnEmpty.FAIL,
  ...over,
});

/**
 * Agent rules ∧ toolset entry rules (design spec §7.3): the stricter side wins
 * every limit, each rejection names whose rule it was, and none of them is a
 * provider-quality reason.
 */
describe('routing rules — merge (stricter wins)', () => {
  it('keeps the higher minimum tier and names its side', () => {
    const merged = mergeRules({
      agent: AGENT({ minTier: ProviderTier.ESTABLISHED }),
      entry: ENTRY({ minTier: ProviderTier.TRUSTED }),
    });
    expect(merged.minTier).toEqual({ value: ProviderTier.TRUSTED, source: RuleSource.TOOLSET });

    const agentStricter = mergeRules({
      agent: AGENT({ minTier: ProviderTier.TRUSTED }),
      entry: ENTRY({ minTier: ProviderTier.NEW }),
    });
    expect(agentStricter.minTier).toEqual({
      value: ProviderTier.TRUSTED,
      source: RuleSource.AGENT,
    });
  });

  it('gives a tie to the agent, whose rules hold on every URL', () => {
    const merged = mergeRules({
      agent: AGENT({ minTier: ProviderTier.ESTABLISHED }),
      entry: ENTRY({ minTier: ProviderTier.ESTABLISHED }),
    });
    expect(merged.minTier?.source).toBe(RuleSource.AGENT);
  });

  it('keeps the lower maximum price when both are in one asset', () => {
    const merged = mergeRules({
      agent: AGENT({ maxPrice: usdc('0.10') }),
      entry: ENTRY({ maxPrice: usdc('0.02') }),
    });
    expect(merged.maxPrices).toEqual([{ value: usdc('0.02'), source: RuleSource.TOOLSET }]);
  });

  it('keeps both maxima when their assets differ, since they cannot be compared', () => {
    const other = MoneyUtil.of(
      '5',
      'eip155:46630/erc20:0x0000000000000000000000000000000000000001' as never,
      6,
    );
    const merged = mergeRules({
      agent: AGENT({ maxPrice: usdc('0.10') }),
      entry: ENTRY({ maxPrice: other }),
    });
    expect(merged.maxPrices).toHaveLength(2);
  });

  it('keeps the higher minimum quality', () => {
    const merged = mergeRules({
      agent: AGENT({ minQuality: 0.8 }),
      entry: ENTRY({ minQuality: 0.95 }),
    });
    expect(merged.minQuality).toEqual({ value: 0.95, source: RuleSource.TOOLSET });
  });

  it('builds the allow set only for ONLY and the toolset exclusions only for EXCLUDE', () => {
    expect(
      mergeRules({ agent: null, entry: ENTRY({ mode: ProviderMode.ONLY, providerIds: ['p1'] }) })
        .allowProviderIds,
    ).toEqual(new Set(['p1']));
    const exclude = mergeRules({
      agent: AGENT({ excludeProviderIds: ['p3'] }),
      entry: ENTRY({ mode: ProviderMode.EXCLUDE, providerIds: ['p2'] }),
    });
    expect(exclude.allowProviderIds).toBeNull();
    expect(exclude.excludeByToolset).toEqual(new Set(['p2']));
    expect(exclude.excludeByAgent).toEqual(new Set(['p3']));
  });

  it('drops only the entry preferences for FALLBACK_BEST', () => {
    const rules = { agent: AGENT({ excludeProviderIds: ['p1'] }), entry: ENTRY() };
    expect(withoutEntryPreferences(rules)).toEqual({ agent: rules.agent, entry: null });
  });
});

describe('routing rules — each reason', () => {
  const evaluate = (rules: RoutingRules, candidate = buildCandidate('p1')) =>
    evaluateRules(candidate, mergeRules(rules));

  it('NOT_IN_ALLOWED_PROVIDERS (TOOLSET)', () => {
    expect(
      evaluate({ agent: null, entry: ENTRY({ mode: ProviderMode.ONLY, providerIds: ['p2'] }) }),
    ).toMatchObject({
      reason: RuleRejectionReason.NOT_IN_ALLOWED_PROVIDERS,
      source: RuleSource.TOOLSET,
    });
  });

  it('EXCLUDED_BY_TOOLSET (TOOLSET)', () => {
    expect(
      evaluate({ agent: null, entry: ENTRY({ mode: ProviderMode.EXCLUDE, providerIds: ['p1'] }) }),
    ).toMatchObject({
      reason: RuleRejectionReason.EXCLUDED_BY_TOOLSET,
      source: RuleSource.TOOLSET,
    });
  });

  it('EXCLUDED_BY_AGENT (AGENT)', () => {
    expect(evaluate({ agent: AGENT({ excludeProviderIds: ['p1'] }), entry: null })).toMatchObject({
      reason: RuleRejectionReason.EXCLUDED_BY_AGENT,
      source: RuleSource.AGENT,
    });
  });

  it('BELOW_MIN_TIER, compared on ProviderTier', () => {
    const candidate = buildCandidate('p1', { provider: { tier: ProviderTier.NEW } });
    expect(
      evaluate({ agent: AGENT({ minTier: ProviderTier.ESTABLISHED }), entry: null }, candidate),
    ).toMatchObject({ reason: RuleRejectionReason.BELOW_MIN_TIER, source: RuleSource.AGENT });
    expect(
      evaluate({ agent: AGENT({ minTier: ProviderTier.NEW }), entry: null }, candidate),
    ).toBeNull();
  });

  it('ABOVE_MAX_PRICE, including a price in another asset', () => {
    // The fixture binding costs $0.05.
    expect(evaluate({ agent: null, entry: ENTRY({ maxPrice: usdc('0.04') }) })).toMatchObject({
      reason: RuleRejectionReason.ABOVE_MAX_PRICE,
      source: RuleSource.TOOLSET,
    });
    expect(evaluate({ agent: null, entry: ENTRY({ maxPrice: usdc('0.05') }) })).toBeNull();

    const otherAsset = MoneyUtil.of(
      '1000000',
      'eip155:46630/erc20:0x0000000000000000000000000000000000000001' as never,
      6,
    );
    expect(evaluate({ agent: AGENT({ maxPrice: otherAsset }), entry: null })).toMatchObject({
      reason: RuleRejectionReason.ABOVE_MAX_PRICE,
      detail: expect.stringContaining('different asset'),
    });
  });

  it('a FREE binding is never above a maximum price', () => {
    const candidate = buildCandidate('p1', {
      binding: { pricingMode: PricingMode.FREE, priceAmount: '0' },
    });
    expect(evaluate({ agent: AGENT({ maxPrice: usdc('0') }), entry: null }, candidate)).toBeNull();
  });

  it('BELOW_MIN_QUALITY is stored but inert until G1.1', () => {
    const candidate = buildCandidate('p1', { provider: { stats: { paidQualityRate: 0.5 } } });
    const rules = { agent: AGENT({ minQuality: 0.9 }), entry: null };
    expect(evaluateRules(candidate, mergeRules(rules))).toBeNull();
    expect(evaluateRules(candidate, mergeRules(rules), { enforceMinQuality: true })).toMatchObject({
      reason: RuleRejectionReason.BELOW_MIN_QUALITY,
      source: RuleSource.AGENT,
    });
  });

  it('keeps the candidate order and passes everything with no rules', () => {
    const candidates = [buildCandidate('p1'), buildCandidate('p2'), buildCandidate('p3')];
    expect(applyRules(candidates, null).kept).toBe(candidates);
    const { kept, rejected } = applyRules(candidates, {
      agent: AGENT({ excludeProviderIds: ['p2'] }),
      entry: null,
    });
    expect(kept.map((c) => c.binding.providerId)).toEqual(['p1', 'p3']);
    expect(rejected.map((r) => r.candidate.binding.providerId)).toEqual(['p2']);
  });

  it('puts a refusal on the agent layer whenever an agent rule took part', () => {
    expect(rejectionLayer([{ source: RuleSource.TOOLSET }])).toBe(RuleSource.TOOLSET);
    expect(rejectionLayer([{ source: RuleSource.TOOLSET }, { source: RuleSource.AGENT }])).toBe(
      RuleSource.AGENT,
    );
  });
});

describe('routing rules — the router, in both payment phases', () => {
  const providers = [
    buildProvider('p1', { tier: ProviderTier.TRUSTED }),
    buildProvider('p2', { tier: ProviderTier.NEW }),
  ];
  const bindings = [
    buildBinding('p1', { priceAmount: usdc('0.05').amount }),
    buildBinding('p2', { priceAmount: usdc('0.01').amount }),
  ];
  const stakes = { p1: usdc(1000), p2: usdc(1000) };

  const router = () => {
    const invoker = new ScriptedInvoker({
      'binding-p1': async () => ok(),
      'binding-p2': async () => ok(),
    });
    return { ...buildRouter({ bindings, providers, stakes, invoker }), invoker };
  };

  it('quotes only what the rules leave, with the cheapest for "From $X"', async () => {
    const { router: r } = router();
    const quote = await r.quote(TOOL_ID, {
      ...ROUTING_CONTEXT,
      rules: { agent: AGENT({ excludeProviderIds: ['p1'] }), entry: null },
    });
    expect(quote?.routableBindings).toBe(1);
    expect(quote?.price).toEqual(usdc('0.01'));
    expect(quote?.cheapestPrice).toEqual(usdc('0.01'));
  });

  it('a quote the rules empty has no price and names each provider and source', async () => {
    const { router: r } = router();
    const quote = await r.quote(TOOL_ID, {
      ...ROUTING_CONTEXT,
      rules: {
        agent: AGENT({ excludeProviderIds: ['p1'] }),
        entry: ENTRY({ minTier: ProviderTier.ESTABLISHED }),
      },
    });
    expect(quote?.price).toBeNull();
    expect(quote?.ruleRejections).toEqual([
      expect.objectContaining({
        providerId: 'p1',
        reason: RuleRejectionReason.EXCLUDED_BY_AGENT,
        source: RuleSource.AGENT,
      }),
      expect.objectContaining({
        providerId: 'p2',
        reason: RuleRejectionReason.BELOW_MIN_TIER,
        source: RuleSource.TOOLSET,
      }),
    ]);
  });

  it('offer() refuses NO_PROVIDER_MATCHES_RULES on FAIL', async () => {
    const { router: r } = router();
    await expect(
      r.offer(TOOL_ID, {
        ...ROUTING_CONTEXT,
        rules: { agent: null, entry: ENTRY({ mode: ProviderMode.ONLY, providerIds: ['p9'] }) },
      }),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES });
  });

  it('route() never dials a provider the rules drop', async () => {
    const { router: r, invoker } = router();
    const routed = await r.route({
      toolId: TOOL_ID,
      input: { query: 'Paris' },
      callId: 'call-1',
      context: {
        ...ROUTING_CONTEXT,
        rules: { agent: null, entry: ENTRY({ mode: ProviderMode.ONLY, providerIds: ['p2'] }) },
      },
    });
    expect(routed.providerId).toBe('p2');
    expect(invoker.providerIds).toEqual(['p2']);
    expect(routed.fellBack).toBeUndefined();
  });

  it('FALLBACK_BEST drops the entry preferences but keeps the agent rules', async () => {
    const { router: r } = router();
    const context = {
      ...ROUTING_CONTEXT,
      rules: {
        agent: AGENT({ excludeProviderIds: ['p2'] }),
        entry: ENTRY({
          mode: ProviderMode.ONLY,
          providerIds: ['p9'],
          onEmpty: OnEmpty.FALLBACK_BEST,
        }),
      },
    };
    const offer = await r.offer(TOOL_ID, context);
    expect(offer.providerId).toBe('p1');
    expect(offer.fellBack).toBe(true);

    // The agent rule still holds: with p1 excluded too, fallback has nobody.
    await expect(
      r.offer(TOOL_ID, {
        ...context,
        rules: { ...context.rules, agent: AGENT({ excludeProviderIds: ['p1', 'p2'] }) },
      }),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES });
  });

  it('FALLBACK_BEST keeps the hard constraints: the gates still run', async () => {
    const { router: r } = buildRouter({
      bindings,
      providers,
      stakes: {},
      invoker: new ScriptedInvoker({}),
    });
    await expect(
      r.offer(TOOL_ID, {
        ...ROUTING_CONTEXT,
        rules: {
          agent: null,
          entry: ENTRY({
            mode: ProviderMode.ONLY,
            providerIds: ['p9'],
            onEmpty: OnEmpty.FALLBACK_BEST,
          }),
        },
      }),
    ).rejects.toMatchObject({ errorCode: ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING });
  });

  it('rail B retry: a pinned payee the rules now drop is PAYEE_NO_LONGER_ELIGIBLE', async () => {
    const { router: r } = router();
    const refusal = await r
      .offer(TOOL_ID, {
        ...ROUTING_CONTEXT,
        onlyProviderId: 'p1',
        rules: { agent: AGENT({ excludeProviderIds: ['p1'] }), entry: null },
      })
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({ errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES });
    expect((refusal as { context: { details: unknown } }).context.details).toEqual({
      toolId: TOOL_ID,
      providers: [
        expect.objectContaining({
          providerId: 'p1',
          reason: RuleRejectionReason.PAYEE_NO_LONGER_ELIGIBLE,
          rule: RuleRejectionReason.EXCLUDED_BY_AGENT,
          source: RuleSource.AGENT,
        }),
      ],
    });
  });

  it('rail B retry: the pool is onlyProviderId ∩ allowProviderIds', async () => {
    const { router: r } = router();
    const rules = { agent: null, entry: ENTRY({ mode: ProviderMode.ONLY, providerIds: ['p2'] }) };
    await expect(
      r.offer(TOOL_ID, { ...ROUTING_CONTEXT, onlyProviderId: 'p1', rules }),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES });
    await expect(
      r.offer(TOOL_ID, { ...ROUTING_CONTEXT, onlyProviderId: 'p2', rules }),
    ).resolves.toMatchObject({ providerId: 'p2' });
  });

  describe('FALLBACK_BEST is decided on the whole pool, then the pin applies', () => {
    const onlyP1 = {
      agent: null,
      entry: ENTRY({
        mode: ProviderMode.ONLY,
        providerIds: ['p1'],
        onEmpty: OnEmpty.FALLBACK_BEST,
      }),
    };

    it('offer() never falls back while the entry list has an eligible provider', async () => {
      const { router: r } = router();
      const offer = await r.offer(TOOL_ID, { ...ROUTING_CONTEXT, rules: onlyP1 });
      expect(offer.providerId).toBe('p1');
      expect(offer.fellBack).toBeUndefined();
    });

    it('a voucher pinned to a provider outside the list is PAYEE_NO_LONGER_ELIGIBLE, in offer and route', async () => {
      const { router: r, invoker } = router();
      const context = { ...ROUTING_CONTEXT, onlyProviderId: 'p2', rules: onlyP1 };

      const refusal = await r.offer(TOOL_ID, context).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES });
      expect(
        (refusal as { context: { details: { providers: unknown[] } } }).context.details.providers,
      ).toEqual([
        expect.objectContaining({
          providerId: 'p2',
          reason: RuleRejectionReason.PAYEE_NO_LONGER_ELIGIBLE,
          rule: RuleRejectionReason.NOT_IN_ALLOWED_PROVIDERS,
        }),
      ]);

      await expect(
        r.route({ toolId: TOOL_ID, input: { query: 'Paris' }, callId: 'call-2', context }),
      ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES });
      expect(invoker.invocations).toHaveLength(0);
    });

    it('falls back for the pin only when the list leaves nobody in the whole pool', async () => {
      const { router: r } = buildRouter({
        bindings,
        providers,
        // p1 is unstaked, so the entry list leaves nobody.
        stakes: { p2: usdc(1000) },
        invoker: new ScriptedInvoker({}),
      });
      const offer = await r.offer(TOOL_ID, {
        ...ROUTING_CONTEXT,
        onlyProviderId: 'p2',
        rules: onlyP1,
      });
      expect(offer).toMatchObject({ providerId: 'p2', fellBack: true });
    });

    it('a failover exclusion does not trigger the fallback', async () => {
      const { router: r } = router();
      await expect(
        r.offer(TOOL_ID, { ...ROUTING_CONTEXT, excludeProviderIds: ['p1'], rules: onlyP1 }),
      ).rejects.toBeDefined();
    });
  });

  it('quoteFromCandidates prices a snapshot without gathering again', async () => {
    const { router: r } = router();
    const snapshot = await r.snapshotCandidates(TOOL_ID);
    const quote = r.quoteFromCandidates(buildTool(), snapshot, ROUTING_CONTEXT);
    expect(quote.routableBindings).toBe(2);
    expect(quote.price?.asset).toBe(STAKE_ASSET);
  });
});
