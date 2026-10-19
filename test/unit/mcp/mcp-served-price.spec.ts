import { offerSolanaRailAInThisSuite, offerSolanaRailsInThisSuite } from '../helpers/solana-rail-b';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { FreeQuotaService } from '@modules/free-tier/services/free-quota.service';
import { McpCatalogueService } from '@modules/mcp/services/mcp-catalogue.service';
import { NO_CONTRACT_REQUEST } from '@modules/tool/domain/contract/contract-versions';
import { MinimumStakeParameters, RoutingContext } from '@modules/tool/domain/routing';
import { ToolContractVersion, ToolTier, ToolVersionStatus } from '@modules/tool/ports/tool.types';
import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { MoneyUtil } from '@utils/money.util';
import { ASSAY_PRICE } from '@modules/mcp/constants/mcp.constants';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { McpScope } from '@modules/mcp/ports/mcp-scope';
import { McpPriceAnnotation } from '@modules/mcp/services/mcp-catalogue.service';
import { VoucherRequirement } from '@modules/mcp/services/mcp-tool-call.service';
import { PaymentIntentStatus, PaymentRail } from '@modules/payment/ports/payment.types';
import { ProviderTier } from '@modules/provider/ports/provider.types';
import { OnEmpty, ProviderMode, RoutingRules } from '@modules/tool/domain/routing';
import { PricingMode, Tool, ToolBinding } from '@modules/tool/ports/tool.types';
import { attributionOf } from '@modules/toolset/domain/attribution';
import { ALLOW_ALL } from '@modules/toolset/domain/access';
import { EndpointKind, McpPathKind, parseMcpUrl } from '@modules/toolset/domain/mcp-url';
import { McpEndpointView } from '@modules/toolset/domain/view';

import {
  ScriptedInvoker,
  buildBinding,
  buildProvider,
  MINIMUM_STAKE,
  PAYOUT_CHAIN,
  TOOL_ID,
  buildRouter,
  buildTool,
  ok,
  status,
  usdc,
} from '../tool/helpers/routing-fixtures';
import { CHAIN_ID, FakeFreeQuota, SESSION, buildMcpHarness } from './helpers/mcp-harness';

/**
 * Rail A: held at the quote, charged at the price of the binding that served.
 *
 * The quote is the dearest eligible binding — the most the call can cost,
 * whichever provider failover lands on — and the hold covers it. Once a binding
 * has served, the intent is re-priced to that binding's own price (never above
 * the hold), so the cheaper provider is credited its own price and settlement
 * gives the buyer back the rest of the hold.
 */
describe('McpToolCallService — the buyer pays the binding that served', () => {
  // Solana has no paid rail by default (review 2026-10-15, C1); these cases
  // pin the rail-A code that is kept for when it is switched back on.
  offerSolanaRailAInThisSuite();

  const ARGS = { query: 'moon landing' };
  const CHEAP = usdc('0.05');
  const DEAR = usdc('0.10');

  function harness(cheap: () => ReturnType<typeof ok> | ReturnType<typeof status>) {
    return buildMcpHarness({
      bindings: [
        // Drawn first under `random: () => 0`.
        buildBinding('provider-a', { priceAmount: CHEAP.amount }),
        buildBinding('provider-b', { priceAmount: DEAR.amount }),
      ],
      providers: [buildProvider('provider-a'), buildProvider('provider-b')],
      invoker: new ScriptedInvoker({
        'binding-provider-a': () => Promise.resolve(cheap()),
        'binding-provider-b': () => Promise.resolve(ok('dear')),
      }),
      random: () => 0,
    });
  }

  it('holds the quote and re-prices the intent to the cheaper binding that served', async () => {
    const { calls, intents, ledger } = harness(() => ok('cheap'));

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('RESULT');
    if (outcome.kind !== 'RESULT') return;
    // Held at the dearest binding: the bound the agent agreed to.
    expect(ledger.events[0]).toMatchObject({ kind: 'HOLD_CREATE', money: DEAR });
    expect(outcome.receipt.held).toEqual(DEAR);

    // Charged — once verification settles — at the serving binding's own price.
    const intent = intents.only;
    expect(intent.status).toBe(PaymentIntentStatus.VERIFYING);
    expect(intent.providerId).toBe('provider-a');
    expect(intent.price).toEqual(CHEAP);
    expect(intent.platformFee).toEqual(usdc('0.005'));
    expect(intent.providerAmount).toEqual(usdc('0.045'));
  });

  it('charges the dearer binding its own price when failover lands on it', async () => {
    const { calls, intents } = harness(() => status(503));

    await calls.call(SESSION, 'Search the web', ARGS);

    expect(intents.only.providerId).toBe('provider-b');
    expect(intents.only.price).toEqual(DEAR);
    expect(intents.only.providerAmount).toEqual(usdc('0.09'));
  });
});

/**
 * `assay/price.maxAmount` (spec §7.10 item 3, G3): the highest price among
 * the providers the merged rules leave, in atomic units of `asset`. The local
 * proxy refuses to sign above it, so no offer the server makes for that call —
 * rail B's exact voucher amount, rail A's hold and its charge — may exceed it,
 * whichever provider the draw lands on and whatever rules the URL and the
 * agent carry.
 */
describe('assay/price.maxAmount bounds every offer for the call', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  const AGENT = `${CHAIN_ID}:Agent1111111111111111111111111111111111111` as AccountId;
  const RAIL_B_SESSION: McpSession = { ...SESSION, agentAccount: AGENT };
  const ARGS = { query: 'moon landing' };
  const TOOL_NAME = 'Search the web';

  const PRICES: Record<string, string> = { p1: '0.01', p2: '0.05', p3: '0.10' };
  const TIERS: Record<string, ProviderTier> = {
    p1: ProviderTier.TRUSTED,
    p2: ProviderTier.ESTABLISHED,
    p3: ProviderTier.NEW,
  };

  function view(entry: RoutingRules['entry'] = null): McpEndpointView {
    const url = entry ? '/my/research' : '/?discovery=full';
    const parsed = parseMcpUrl(url)!;
    return {
      canonicalUrl: `https://mcp.example.com${url}`,
      path: entry ? { kind: McpPathKind.MY_TOOLSET, slug: 'research', version: null } : parsed.path,
      kind: entry ? EndpointKind.TOOLSET : EndpointKind.ROOT,
      filter: parsed.filter,
      toolset: entry
        ? { id: 'toolset-1', slug: 'research', name: 'Research', version: null, latest: false }
        : null,
      handle: null,
      baseToolIds: entry ? [TOOL_ID] : null,
      entryRules: entry ? new Map([[TOOL_ID, entry]]) : new Map(),
      notice: null,
    };
  }

  function scopeOf(
    rules: { agent?: RoutingRules['agent']; entry?: RoutingRules['entry'] } = {},
  ): McpScope {
    const v = view(rules.entry ?? null);
    return {
      view: v,
      access: {
        agentId: SESSION.agentId,
        agent: ALLOW_ALL,
        key: null,
        rules: rules.agent ?? null,
        pinnedTools: [],
        policyVersion: 1,
      },
      attribution: attributionOf(v),
    };
  }

  const agentRules = (over: Partial<NonNullable<RoutingRules['agent']>>) => ({
    excludeProviderIds: [],
    maxPrice: null,
    minTier: null,
    minQuality: null,
    ...over,
  });
  const entryRules = (over: Partial<NonNullable<RoutingRules['entry']>>) => ({
    mode: ProviderMode.BEST,
    providerIds: [],
    minTier: null,
    maxPrice: null,
    minQuality: null,
    onEmpty: OnEmpty.FAIL,
    ...over,
  });

  const RULE_SETS: ReadonlyArray<[string, Parameters<typeof scopeOf>[0]]> = [
    ['no rules', {}],
    ['agent excludes the dearest', { agent: agentRules({ excludeProviderIds: ['p3'] }) }],
    ['agent max price $0.05', { agent: agentRules({ maxPrice: usdc('0.05') }) }],
    ['agent min tier ESTABLISHED', { agent: agentRules({ minTier: ProviderTier.ESTABLISHED }) }],
    [
      'entry ONLY the cheapest',
      { entry: entryRules({ mode: ProviderMode.ONLY, providerIds: ['p1'] }) },
    ],
    [
      'entry EXCLUDE the cheapest',
      { entry: entryRules({ mode: ProviderMode.EXCLUDE, providerIds: ['p1'] }) },
    ],
    [
      'entry ONLY nobody, FALLBACK_BEST',
      {
        entry: entryRules({
          mode: ProviderMode.ONLY,
          providerIds: ['nobody'],
          onEmpty: OnEmpty.FALLBACK_BEST,
        }),
      },
    ],
    [
      'entry max price $0.05 and agent excludes the cheapest',
      {
        entry: entryRules({ maxPrice: usdc('0.05') }),
        agent: agentRules({ excludeProviderIds: ['p1'] }),
      },
    ],
  ];

  // Draws that land on the first, a middle and the last candidate.
  const DRAWS = [0, 0.5, 0.999];

  function harness(
    random: () => number,
    bindings: readonly ToolBinding[] = Object.keys(PRICES).map((id) =>
      buildBinding(id, { priceAmount: usdc(PRICES[id]).amount }),
    ),
  ) {
    const ids = bindings.map((binding) => binding.providerId);
    return buildMcpHarness({
      bindings,
      providers: ids.map((id) =>
        buildProvider(id, { tier: TIERS[id] ?? ProviderTier.ESTABLISHED }),
      ),
      invoker: new ScriptedInvoker(
        Object.fromEntries(ids.map((id) => [`binding-${id}`, async () => ok(id)])),
      ),
      random,
    });
  }

  async function quotedPrice(
    h: ReturnType<typeof harness>,
    scope?: McpScope,
  ): Promise<McpPriceAnnotation> {
    const [descriptor] = await h.catalogue.listTools(
      { organizationId: SESSION.organizationId, agentId: SESSION.agentId, chainId: CHAIN_ID },
      scope,
    );
    return descriptor.annotations[ASSAY_PRICE] as McpPriceAnnotation;
  }

  async function railBOffer(h: ReturnType<typeof harness>, scope: McpScope) {
    const outcome = await h.calls.call(
      RAIL_B_SESSION,
      TOOL_NAME,
      ARGS,
      { rail: PaymentRail.RAIL_B_VOUCHER, voucher: null },
      scope,
    );
    if (outcome.kind !== 'ERROR') throw new Error('expected a payment requirement');
    return (outcome.detail.paymentRequired as VoucherRequirement).amount;
  }

  for (const [label, rules] of RULE_SETS) {
    it(`${label}: every rail B offer and rail A hold/charge is ≤ maxAmount`, async () => {
      const max = BigInt(
        (
          await quotedPrice(
            harness(() => 0),
            scopeOf(rules),
          )
        ).maxAmount,
      );

      let dearestOffered = 0n;
      for (const draw of DRAWS) {
        const offered = await railBOffer(
          harness(() => draw),
          scopeOf(rules),
        );
        if (BigInt(offered.amount) > dearestOffered) dearestOffered = BigInt(offered.amount);
        expect(offered.asset).toBe(usdc('0.01').asset);
        expect(BigInt(offered.amount)).toBeLessThanOrEqual(max);

        const h = harness(() => draw);
        const outcome = await h.calls.call(SESSION, TOOL_NAME, ARGS, undefined, scopeOf(rules));
        if (outcome.kind !== 'RESULT') throw new Error('expected a RESULT');
        expect(BigInt(outcome.receipt.held.amount)).toBeLessThanOrEqual(max);
        expect(BigInt(h.intents.only.price.amount)).toBeLessThanOrEqual(max);
      }
      // And it is the bound, not a loose ceiling: some draw is offered exactly it.
      expect(dearestOffered).toBe(max);
    });
  }

  it('is exact atomic units, never a float: an integer string', async () => {
    const price = await quotedPrice(
      harness(() => 0),
      scopeOf(),
    );
    expect(price.maxAmount).toMatch(/^(0|[1-9][0-9]*)$/);
  });

  it('free tool → maxAmount "0"', async () => {
    const h = harness(
      () => 0,
      [
        buildBinding('p1', {
          pricingMode: PricingMode.FREE,
          priceAmount: '0',
          freeQuotaPerAgent: 10,
        }),
      ],
    );
    const price = await quotedPrice(h, scopeOf());
    expect(price.display).toBe('free');
    expect(price.maxAmount).toBe('0');
  });

  it('two bindings 0.01/0.05 → maxAmount 50000', async () => {
    const h = harness(
      () => 0,
      [
        buildBinding('p1', { priceAmount: usdc('0.01').amount }),
        buildBinding('p2', { priceAmount: usdc('0.05').amount }),
      ],
    );
    expect((await quotedPrice(h, scopeOf())).maxAmount).toBe('50000');
    // The unscoped (REST) listing carries it too.
    expect((await quotedPrice(h)).maxAmount).toBe('50000');
  });

  it('a rule excluding the 0.05 provider → 10000, equal to amount (the quote is rule-filtered)', async () => {
    const h = harness(
      () => 0,
      [
        buildBinding('p1', { priceAmount: usdc('0.01').amount }),
        buildBinding('p2', { priceAmount: usdc('0.05').amount }),
      ],
    );
    const price = await quotedPrice(
      h,
      scopeOf({ agent: agentRules({ excludeProviderIds: ['p2'] }) }),
    );
    expect(price.maxAmount).toBe('10000');
    expect(price.maxAmount).toBe(price.amount);
  });

  it('a FREEMIUM tool → maxAmount is the paid price a call past the quota is held for', async () => {
    const h = harness(
      () => 0,
      [
        buildBinding('p1', {
          pricingMode: PricingMode.FREE,
          priceAmount: '0',
          freeQuotaPerAgent: 10,
        }),
        buildBinding('p2', { priceAmount: usdc('0.05').amount }),
      ],
    );
    const price = await quotedPrice(h, scopeOf());
    expect(price.maxAmount).toBe('50000');

    // The same tool on a `?free=1` URL never takes the paid path (review M2).
    const parsed = parseMcpUrl('/?free=1&discovery=full')!;
    const freeView: McpEndpointView = {
      ...view(),
      canonicalUrl: 'https://mcp.example.com/?free=1&discovery=full',
      path: parsed.path,
      filter: parsed.filter,
    };
    const freeScope: McpScope = {
      ...scopeOf(),
      view: freeView,
      attribution: attributionOf(freeView),
    };
    const free = await quotedPrice(h, freeScope);
    expect(free.amount).toBe('50000');
    expect(free.maxAmount).toBe('0');
  });
});

/**
 * The listing and the live call, built from the same router: the listing
 * through the catalogue's own quote index (a snapshot, as in production), the
 * offer through `router.offer` exactly as rail B asks it.
 */
function listingAndRouter(options: {
  tool?: Tool;
  bindings: readonly ToolBinding[];
  providers: Parameters<typeof buildRouter>[0]['providers'];
  stakes: Parameters<typeof buildRouter>[0]['stakes'];
  stakesByChain?: Parameters<typeof buildRouter>[0]['stakesByChain'];
  config?: Parameters<typeof buildRouter>[0]['config'];
  random?: () => number;
  enabledChains: readonly ChainId[];
}) {
  const tool = options.tool ?? buildTool();
  const harness = buildRouter({
    tool,
    bindings: options.bindings,
    providers: options.providers,
    stakes: options.stakes,
    stakesByChain: options.stakesByChain,
    config: options.config,
    random: options.random,
    invoker: new ScriptedInvoker(
      Object.fromEntries(options.bindings.map((b) => [b.id, async () => ok()])),
    ),
  });
  const catalogue = new McpCatalogueService(
    new InMemoryToolCatalogue({ tools: [tool], bindings: options.bindings }),
    harness.router,
    new FakeFreeQuota() as unknown as FreeQuotaService,
    options.enabledChains,
  );
  return { ...harness, catalogue };
}

function offerContext(chainId: ChainId, enabledChains: readonly ChainId[]): RoutingContext {
  return {
    payerChains: [chainId],
    defaultChainId: chainId,
    enabledChains,
    withdrawingChains: [],
    callClass: 'PAID',
    contract: NO_CONTRACT_REQUEST,
  };
}

async function listedPrice(
  catalogue: McpCatalogueService,
  chainId: ChainId,
): Promise<McpPriceAnnotation> {
  const [descriptor] = await catalogue.listTools({
    organizationId: SESSION.organizationId,
    agentId: SESSION.agentId,
    chainId,
  });
  return descriptor.annotations[ASSAY_PRICE] as McpPriceAnnotation;
}

describe('maxAmount across contract versions and chains (review I1)', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  // v1 is served only on the viewer's chain X at $0.10; v2 (current) only on
  // chain Y at $0.05. A buyer on X is offered v1 at $0.10, so its listing must
  // quote v1 on X — not v2 on Y.
  const X = PAYOUT_CHAIN;
  const Y = CHAIN_IDS.SOLANA_MAINNET;
  const Y_USDC = ASSET_IDS.USDC_SOLANA_MAINNET as AssetId;
  const Y_PAYOUT = `${Y}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` as AccountId;
  const yUsdc = (amount: string) => MoneyUtil.of(amount, Y_USDC, 6);
  const Y_MINIMUM: MinimumStakeParameters = { floor: yUsdc('50000000'), priceMultiple: 1000 };

  function version(major: number): ToolContractVersion {
    const base = buildTool();
    return {
      version: major,
      semver: `${major}.0.0`,
      major,
      summary: 's',
      description: base.description,
      inputSchema: base.inputSchema,
      outputSchema: base.outputSchema,
      optionalInputFields: [],
      optionalOutputFields: [],
      examples: [],
      verificationPolicyId: 'policy-default',
      tier: ToolTier.VERIFIED,
      status: ToolVersionStatus.ACTIVE,
      sunsetAt: null,
      changelog: null,
      publishedAt: null,
    };
  }

  function setup() {
    return listingAndRouter({
      tool: buildTool({ versions: [version(2), version(1)], currentVersion: 2 }),
      bindings: [
        buildBinding('on-x', { toolVersionRange: '^1', priceAmount: usdc('0.10').amount }),
        buildBinding('on-y', {
          toolVersionRange: '^2',
          assetId: Y_USDC,
          priceAmount: yUsdc('50000').amount,
        }),
      ],
      providers: [
        buildProvider('on-x'),
        buildProvider('on-y', { payoutAccountByChain: new Map([[Y, Y_PAYOUT]]) }),
      ],
      stakes: { 'on-x': usdc(1000) },
      stakesByChain: { [`on-y|${Y}`]: yUsdc('1000000000') },
      config: {
        minimumStakeByChain: new Map([
          [X, MINIMUM_STAKE],
          [Y, Y_MINIMUM],
        ]),
      },
      enabledChains: [X, Y],
    });
  }

  it('an X buyer is listed the version, asset and price it is offered; offer ≤ maxAmount', async () => {
    const { catalogue, router } = setup();
    const listed = await listedPrice(catalogue, X);
    const offer = await router.offer(TOOL_ID, offerContext(X, [X, Y]));

    expect(offer.contractVersion).toBe(1);
    expect(listed.asset).toBe(offer.price.asset);
    expect(listed.amount).toBe(usdc('0.10').amount);
    expect(BigInt(offer.price.amount)).toBeLessThanOrEqual(BigInt(listed.maxAmount));
  });

  it('a Y buyer is listed v2 in Y’s asset, and its offer is ≤ maxAmount too', async () => {
    const { catalogue, router } = setup();
    const listed = await listedPrice(catalogue, Y);
    const offer = await router.offer(TOOL_ID, offerContext(Y, [X, Y]));

    expect(offer.contractVersion).toBe(2);
    expect(listed.asset).toBe(Y_USDC);
    expect(listed.asset).toBe(offer.price.asset);
    expect(BigInt(offer.price.amount)).toBeLessThanOrEqual(BigInt(listed.maxAmount));
  });
});

describe('maxAmount with a dearer binding at its ceiling when the listing is priced (review I2)', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  // $0.01 and $0.05 serve; $0.10 declares one call a day and has spent it.
  const bindings = [
    buildBinding('cheap', { priceAmount: usdc('0.01').amount }),
    buildBinding('mid', { priceAmount: usdc('0.05').amount }),
    buildBinding('dear', { priceAmount: usdc('0.10').amount, maxDailyCalls: 1 }),
  ];

  it('keeps the listed amount, bounds by the dear binding, and covers the live offer once the ceiling clears', async () => {
    const h = listingAndRouter({
      bindings,
      providers: bindings.map((b) => buildProvider(b.providerId)),
      stakes: Object.fromEntries(bindings.map((b) => [b.providerId, usdc(1000)])),
      // The last candidate: the dear binding once it can serve again.
      random: () => 0.999,
      enabledChains: [CHAIN_ID],
    });
    expect(await h.ceilings.consume(bindings[2])).toBeNull();

    // The index loads now, with the dear binding at its ceiling.
    const listed = await listedPrice(h.catalogue, CHAIN_ID);
    expect(listed.amount).toBe(usdc('0.05').amount);
    expect(listed.display).toBe('up to $0.05');
    expect(listed.maxAmount).toBe(usdc('0.10').amount);

    // The day turns over: the ceiling clears, the snapshot does not.
    h.redis.flush();
    expect((await listedPrice(h.catalogue, CHAIN_ID)).amount).toBe(usdc('0.05').amount);

    const offer = await h.router.offer(TOOL_ID, offerContext(CHAIN_ID, [CHAIN_ID]));
    expect(offer.providerId).toBe('dear');
    expect(BigInt(offer.price.amount)).toBeLessThanOrEqual(BigInt(listed.maxAmount));
  });

  it('a FREE listing with a paid binding at its ceiling is bounded by that binding, not "0"', async () => {
    const mixed = [
      buildBinding('free', {
        pricingMode: PricingMode.FREE,
        priceAmount: '0',
        freeQuotaPerAgent: 10,
      }),
      buildBinding('paid', { priceAmount: usdc('0.05').amount, maxDailyCalls: 1 }),
    ];
    const h = listingAndRouter({
      bindings: mixed,
      providers: mixed.map((b) => buildProvider(b.providerId)),
      stakes: Object.fromEntries(mixed.map((b) => [b.providerId, usdc(1000)])),
      enabledChains: [CHAIN_ID],
    });
    await h.ceilings.consume(mixed[1]);

    const listed = await listedPrice(h.catalogue, CHAIN_ID);
    expect(listed.display).toBe('free');
    expect(listed.maxAmount).toBe(usdc('0.05').amount);
  });
});
