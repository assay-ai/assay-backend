import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { FreeQuotaService } from '@modules/free-tier/services/free-quota.service';
import {
  X402_FREE_QUOTA,
  X402_PAID_ALTERNATIVE,
  X402_PRICE,
  X402_PRICING_MODE,
  X402_QUALITY_RATE,
  X402_SETTLEMENT_CHAINS,
  X402_TIER,
  X402_TOOL_ID,
} from '@modules/mcp/constants/mcp.constants';
import {
  McpCatalogueService,
  McpPriceAnnotation,
} from '@modules/mcp/services/mcp-catalogue.service';
import { ProviderStatus } from '@modules/provider/ports/provider.types';
import { BindingStatus, PricingMode, ToolTier } from '@modules/tool/ports/tool.types';
import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { ProviderRouterService, ToolQuote } from '@modules/tool/services/provider-router.service';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { MoneyUtil } from '@utils/money.util';

import {
  MINIMUM_STAKE_BY_CHAIN,
  ScriptedInvoker,
  buildBinding,
  buildProvider,
  buildRouter,
  buildTool,
  usdc,
} from '../tool/helpers/routing-fixtures';
import { FakeFreeQuota, buildMcpHarness } from './helpers/mcp-harness';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * `tools/list`.
 *
 * The suite is built around one claim: **an agent can read the price before it
 * spends anything.** Everything else here is a way that claim can quietly stop
 * being true — the annotation stripped by a client, a tool listed with no
 * price, a price taken from a binding routing would refuse.
 */
describe('McpCatalogueService — tools/list carries the price', () => {
  const invoker = new ScriptedInvoker({});

  it('publishes the price as an annotation on the tool', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [buildBinding('provider-a')],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();
    const price = descriptor.annotations[X402_PRICE] as McpPriceAnnotation;

    expect(price.amount).toBe(usdc('0.05').amount);
    expect(price.asset).toBe(usdc('0.05').asset);
    expect(price.display).toBe('$0.05');
  });

  /**
   * The reason `DUPLICATED_INTO_META` exists.
   *
   * `ToolSchema.annotations` is a closed object in the MCP specification and the
   * reference SDK strips every key it does not know, so an SDK client sees no
   * price at all unless the same values are also in `_meta`. This test is the
   * guard on that: it fails the moment somebody "cleans up" the duplication.
   */
  it('repeats every published value in _meta, which is what an SDK client keeps', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [buildBinding('provider-a')],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();

    expect(descriptor._meta).toEqual(descriptor.annotations);
    expect(descriptor._meta[X402_PRICE]).toBeDefined();
  });

  it('quotes the dearest eligible binding, so the call never costs more than the quote', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [
        buildBinding('provider-a', { priceAmount: usdc('0.05').amount }),
        buildBinding('provider-b', { priceAmount: usdc('0.09').amount }),
      ],
      providers: [buildProvider('provider-a'), buildProvider('provider-b')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();

    expect((descriptor.annotations[X402_PRICE] as McpPriceAnnotation).amount).toBe(
      usdc('0.09').amount,
    );
  });

  it('ignores a binding routing would refuse when pricing the tool', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [
        buildBinding('provider-a', { priceAmount: usdc('0.05').amount }),
        // Dearer, and suspended. A quote that read it would advertise a price
        // no agent can ever be charged.
        buildBinding('provider-b', {
          priceAmount: usdc('0.90').amount,
          status: BindingStatus.SUSPENDED,
        }),
      ],
      providers: [buildProvider('provider-a'), buildProvider('provider-b')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();

    expect((descriptor.annotations[X402_PRICE] as McpPriceAnnotation).amount).toBe(
      usdc('0.05').amount,
    );
  });

  it('omits a tool with no routable supply rather than listing it unpriced', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [buildBinding('provider-a')],
      providers: [buildProvider('provider-a', { status: ProviderStatus.SUSPENDED })],
      invoker,
    });

    await expect(catalogue.listTools()).resolves.toEqual([]);
  });

  it('publishes the tier in lower case', async () => {
    const { catalogue } = buildMcpHarness({
      tool: buildTool({ tier: ToolTier.GUARANTEED }),
      bindings: [buildBinding('provider-a')],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();
    expect(descriptor.annotations[X402_TIER]).toBe('guaranteed');
  });

  it('renders a free binding as "free" rather than as a zero', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [buildBinding('provider-a', { pricingMode: PricingMode.FREE, priceAmount: '0' })],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();
    const price = descriptor.annotations[X402_PRICE] as McpPriceAnnotation;

    expect(price.amount).toBe('0');
    expect(price.display).toBe('free');
  });

  /**
   * A statistic nobody has measured must not be published as a number. `0` is
   * "measured, and terrible"; absence is the truth.
   */
  it('omits a statistic no provider has a value for', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [buildBinding('provider-a')],
      providers: [buildProvider('provider-a', { stats: {} })],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();

    expect(descriptor.annotations).not.toHaveProperty(X402_QUALITY_RATE);
  });

  it('weights a statistic by the traffic each provider would actually take', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [buildBinding('provider-a'), buildBinding('provider-b')],
      providers: [
        buildProvider('provider-a', { stats: { paidQualityRate: 1 } }),
        buildProvider('provider-b', { stats: { paidQualityRate: 0 } }),
      ],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();
    const rate = descriptor.annotations[X402_QUALITY_RATE] as number;

    // Two providers, so the published figure lies strictly between theirs — it
    // is neither a max nor a min, and neither provider's number alone.
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(1);
  });

  it('carries the platform tool id, so a receipt can be joined to a listing', async () => {
    const tool = buildTool();
    const { catalogue } = buildMcpHarness({
      tool,
      bindings: [buildBinding('provider-a')],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();
    expect(descriptor.annotations[X402_TOOL_ID]).toBe(tool.id);
  });

  it('refuses a name the catalogue does not hold', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [buildBinding('provider-a')],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    await expectErrorCodeAsync(() => catalogue.findByName('no_such_tool'), 'MCP_TOOL_NOT_FOUND');
  });
});

/**
 * The free-tier annotations.
 */
describe('McpCatalogueService — free-tier annotations', () => {
  const invoker = new ScriptedInvoker({});
  const VIEWER = { organizationId: 'org-viewer', agentId: 'agent-viewer' };

  it('publishes x402/pricingMode on a FREE tool', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [buildBinding('provider-a', { pricingMode: PricingMode.FREE, priceAmount: '0' })],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();
    expect(descriptor.annotations[X402_PRICING_MODE]).toBe(PricingMode.FREE);
  });

  it('publishes x402/pricingMode on a FREEMIUM tool', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [buildBinding('provider-a', { pricingMode: PricingMode.FREEMIUM })],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();
    expect(descriptor.annotations[X402_PRICING_MODE]).toBe(PricingMode.FREEMIUM);
  });

  it('omits x402/pricingMode on a PAID tool', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [buildBinding('provider-a', { pricingMode: PricingMode.PAID })],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();
    expect(descriptor.annotations).not.toHaveProperty(X402_PRICING_MODE);
  });

  it('omits x402/freeQuota when no viewer is supplied — no number is nobody’s', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [buildBinding('provider-a', { pricingMode: PricingMode.FREE, priceAmount: '0' })],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();
    expect(descriptor.annotations).not.toHaveProperty(X402_FREE_QUOTA);
  });

  it('publishes this agent’s own x402/freeQuota when a viewer is supplied', async () => {
    const tool = buildTool();

    const harness = buildMcpHarness({
      tool,
      bindings: [buildBinding('provider-a', { pricingMode: PricingMode.FREE, priceAmount: '0' })],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    harness.freeQuota.setRemaining(tool.id, {
      remaining: 87,
      limit: 100,
      resetsAt: new Date('2026-08-11T00:00:00.000Z'),
    });

    const [descriptor] = await harness.catalogue.listTools(VIEWER);
    expect(descriptor.annotations[X402_FREE_QUOTA]).toEqual({
      remaining: 87,
      limit: 100,
      resetsAt: '2026-08-11T00:00:00.000Z',
    });
  });

  it('a FREEMIUM tool’s x402/paidAlternative is its own name — the honest answer this catalogue can give', async () => {
    const tool = buildTool({ name: 'search_web' });
    const { catalogue } = buildMcpHarness({
      tool,
      bindings: [buildBinding('provider-a', { pricingMode: PricingMode.FREEMIUM })],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();
    expect(descriptor.annotations[X402_PAID_ALTERNATIVE]).toBe('search_web');
  });

  it('a FREE-only tool publishes no x402/paidAlternative — no cross-tool pairing exists to name', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [buildBinding('provider-a', { pricingMode: PricingMode.FREE, priceAmount: '0' })],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();
    expect(descriptor.annotations).not.toHaveProperty(X402_PAID_ALTERNATIVE);
  });
});

/**
 * `x402/settlementChains` — the caveat that makes a price honest.
 *
 * The catalogue is deliberately **not** filtered to the buyer's own chains:
 * hiding a tool makes the platform look like it lacks the tool. So a tool that
 * settles somewhere the buyer holds nothing is LISTED, with a price, and the
 * only thing standing between the agent and a `PAYMENT_NO_SETTLEABLE_CHAIN` it
 * did not expect is this annotation. `ToolQuote.settlementChains` has carried
 * the answer since multichain support; until this annotation nothing
 * published it.
 *
 * Two shapes of harness, because two different things can be wrong:
 *
 * - {@link buildMcpHarness} runs the **real** router, so what it proves is that
 *   the value the router computes reaches the descriptor at all — wiring, not
 *   arithmetic. The arithmetic (enrolment narrowing, `ENABLED_CHAINS`, the
 *   union over the routable set) is `test/unit/tool/routing-chains.spec.ts`.
 * - {@link scriptedCatalogue} scripts the quote, because two of the rules below
 *   are about a quote the real router **cannot** produce: an empty
 *   `settlementChains` alongside a price is unreachable (a candidate with no
 *   settleable chain is rejected as `CHAIN_NOT_SETTLEABLE`, which empties
 *   `eligible`, which nulls the price, which omits the tool). A rule that can
 *   only be violated by a future change still has to be pinned.
 */
describe('McpCatalogueService — where a tool settles', () => {
  const invoker = new ScriptedInvoker({});

  /** A catalogue over a scripted quote — see this block's own doc comment. */
  function scriptedCatalogue(settlementChains: readonly ChainId[]): {
    catalogue: McpCatalogueService;
    quote: ToolQuote;
  } {
    const tool = buildTool();
    const quote: ToolQuote = {
      tool,
      price: usdc('0.05'),
      pricingMode: PricingMode.PAID,
      routableBindings: 1,
      settlementChains: [...settlementChains],
      p95LatencyMs: null,
      qualityRate: null,
      unroutableReason: null,
    };

    const catalogue = new McpCatalogueService(
      new InMemoryToolCatalogue({ tools: [tool], bindings: [] }),
      { quote: () => Promise.resolve(quote) } as unknown as ProviderRouterService,
      new FakeFreeQuota() as unknown as FreeQuotaService,
      [CHAIN_IDS.SOLANA_DEVNET],
    );

    return { catalogue, quote };
  }

  it('publishes the chain a real quote settled on', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [buildBinding('provider-a')],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();

    expect(descriptor.annotations[X402_SETTLEMENT_CHAINS]).toEqual([
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    ]);
  });

  /**
   * The loser, asserted. The binding DECLARES two chains and this deployment
   * offers one, so a descriptor built from `binding.settlementChains` would
   * put "settles on Solana mainnet" on a card for a deployment that has the
   * chain switched off — sending the reader to fund a chain that can never
   * route them. What is published is the quote's narrowed union, and mainnet
   * losing is the whole assertion.
   */
  it('publishes only the chains that survived narrowing, not the binding’s declaration', async () => {
    const { catalogue } = buildMcpHarness({
      bindings: [
        buildBinding('provider-a', {
          settlementChains: [CHAIN_IDS.SOLANA_DEVNET, CHAIN_IDS.SOLANA_MAINNET],
        }),
      ],
      providers: [buildProvider('provider-a')],
      invoker,
    });

    const [descriptor] = await catalogue.listTools();

    expect(descriptor.annotations[X402_SETTLEMENT_CHAINS]).toEqual([
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    ]);
    expect(descriptor.annotations[X402_SETTLEMENT_CHAINS]).not.toContain(
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    );
  });

  it('duplicates it into _meta, because the SDK strips annotations', async () => {
    // `ToolSchema.annotations` is `$strip` in the MCP SDK and `_meta` is not,
    // so a value published only in `annotations` reaches no SDK client. The
    // price already ships twice for this reason (memory: `mcp-m14-…`).
    const { catalogue } = scriptedCatalogue([CHAIN_IDS.SOLANA_DEVNET, CHAIN_IDS.SOLANA_MAINNET]);

    const [descriptor] = await catalogue.listTools();

    expect(descriptor._meta[X402_SETTLEMENT_CHAINS]).toEqual([
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    ]);
  });

  it('publishes an empty list rather than omitting the key', async () => {
    // The opposite of `x402/p95LatencyMs`, which is OMITTED when unmeasured
    // because a null in a numeric field is read as zero by more clients than
    // not. An EMPTY list is a fact ("nowhere"), not an absence, and a missing
    // key reads as "settles everywhere" — the one reading that makes the
    // agent's next call fail.
    const { catalogue } = scriptedCatalogue([]);

    const [descriptor] = await catalogue.listTools();

    expect(descriptor.annotations).toHaveProperty(X402_SETTLEMENT_CHAINS, []);
  });

  it('hands out a copy, not the quote’s own array', async () => {
    // `annotations` is handed to an SDK that owns it afterwards; the quote's
    // array belongs to the router.
    const { catalogue, quote } = scriptedCatalogue([CHAIN_IDS.SOLANA_DEVNET]);

    const [descriptor] = await catalogue.listTools();
    (descriptor.annotations[X402_SETTLEMENT_CHAINS] as string[]).push('eip155:1');

    expect(quote.settlementChains).toEqual(['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1']);
  });
});

/**
 * One tool sold on two chains, in two assets (BUG-J-BUY-05).
 *
 * Each viewer is shown the price of the bindings on ITS chain, and the tool
 * carries both chains in `x402/settlementChains`. Before, the two assets met
 * in one quote, it threw, and the throw took down `tools/list` for every
 * agent on the platform.
 */
describe('McpCatalogueService — a tool sold on two chains', () => {
  const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
  const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;
  const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET!;
  const usdg = (atomic: string) => MoneyUtil.of(atomic, USDG, 6);

  function twoChainCatalogue(): McpCatalogueService {
    const tool = buildTool();
    const bindings = [
      buildBinding('sol', { priceAmount: '250000' }),
      buildBinding('evm', { priceAmount: '100000', assetId: USDG, settlementChains: [EVM] }),
    ];
    const { router } = buildRouter({
      tool,
      bindings,
      providers: [
        buildProvider('sol'),
        buildProvider('evm', {
          payoutAccountByChain: new Map([
            [EVM, `${EVM}:0x00000000000000000000000000000000000000aa` as never],
          ]),
        }),
      ],
      stakes: { sol: usdc(1000) },
      stakesByChain: { [`evm|${EVM}`]: usdg('1000000000') },
      invoker: new ScriptedInvoker({}),
      config: {
        minimumStakeByChain: new Map([
          [SOLANA, MINIMUM_STAKE_BY_CHAIN.get(SOLANA)],
          [EVM, { floor: usdg('50000000'), priceMultiple: 1000 }],
        ]) as never,
      },
    });

    return new McpCatalogueService(
      new InMemoryToolCatalogue({ tools: [tool], bindings }),
      router,
      new FakeFreeQuota() as unknown as FreeQuotaService,
      [SOLANA, EVM],
    );
  }

  const viewerOn = (chainId: ChainId) => ({ organizationId: 'org', agentId: 'agent', chainId });

  it('shows an EVM buyer the USDG price', async () => {
    const [descriptor] = await twoChainCatalogue().listTools(viewerOn(EVM));

    expect(descriptor.annotations[X402_PRICE]).toMatchObject({ amount: '100000', asset: USDG });
    expect([...(descriptor.annotations[X402_SETTLEMENT_CHAINS] as string[])].sort()).toEqual(
      [SOLANA, EVM].sort(),
    );
  });

  it('shows a Solana buyer the USDC price', async () => {
    const [descriptor] = await twoChainCatalogue().listTools(viewerOn(SOLANA));

    expect(descriptor.annotations[X402_PRICE]).toMatchObject({
      amount: '250000',
      asset: ASSET_IDS.USDC_SOLANA_DEVNET,
    });
  });
});

describe('McpCatalogueService — one tool cannot break the list', () => {
  it('omits a tool whose quote throws and lists the others', async () => {
    const good = buildTool({ id: 'good', name: 'good' });
    const bad = buildTool({ id: 'bad', name: 'bad' });
    const quoteOf = (toolId: string): Promise<ToolQuote> =>
      toolId === 'bad'
        ? Promise.reject(new Error('catalogue defect'))
        : Promise.resolve({
            tool: good,
            price: usdc('0.05'),
            pricingMode: PricingMode.PAID,
            routableBindings: 1,
            settlementChains: [CHAIN_IDS.SOLANA_DEVNET],
            p95LatencyMs: null,
            qualityRate: null,
            unroutableReason: null,
          });

    const catalogue = new McpCatalogueService(
      new InMemoryToolCatalogue({ tools: [bad, good], bindings: [] }),
      { quote: quoteOf } as unknown as ProviderRouterService,
      new FakeFreeQuota() as unknown as FreeQuotaService,
      [CHAIN_IDS.SOLANA_DEVNET],
    );

    const listed = await catalogue.listTools();

    expect(listed.map((descriptor) => descriptor.name)).toEqual(['good']);
  });
});
