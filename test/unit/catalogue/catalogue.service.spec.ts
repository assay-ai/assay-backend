import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import {
  ProviderQualityCounters,
  SlaWindowRepository,
} from '@database/postgres/repositories/sla-window.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import {
  AccountId,
  AssetId,
  CHAIN_ID_RE,
  CHAIN_IDS,
  ChainId,
  chainIdOf,
} from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { CatalogueService } from '@modules/catalogue/services/catalogue.service';
import { X402_SETTLEMENT_CHAINS } from '@modules/mcp/constants/mcp.constants';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import {
  ChainEnrolment,
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
  enrolmentKey,
} from '@modules/provider/ports/chain-enrolment.port';
import {
  ProviderChainStakeKey,
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '@modules/provider/ports/provider-stake.port';
import { ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { Tool, ToolTier } from '@modules/tool/ports/tool.types';
import { ProviderRouterService, ToolQuote } from '@modules/tool/services/provider-router.service';
import { MoneyUtil } from '@utils/money.util';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';

import { blocklistOf, noBlocks } from '../helpers/blocklist';

/**
 * `GET /catalogue/*` — the buyer's shop window.
 *
 * The screens it feeds were folded from the caller's own `/tool-calls` feed, so
 * a fresh organization saw zero providers on a deployment holding 42, and two
 * people signed in to different accounts saw two different markets. These cases
 * pin the four rules that make the replacement worth trusting:
 *
 * - **listed means callable.** Only `ACTIVE` bindings put a provider or a tool
 *   in the list. A catalogue row is an invitation, and advertising a paused
 *   binding is a promise the router would refuse to keep.
 * - **not measured is not zero, and not perfect.** Quality is `null` until a
 *   window has closed; stake is `null` when the source cannot say. Both have a
 *   tempting default — `0` for stake, `1` for a provider that has never failed —
 *   and both defaults lie in the direction that costs a buyer money.
 * - **the floor and the quote are different numbers.** `fromPrice` is the
 *   cheapest binding; `price` is what the router would hold, which is the
 *   *dearest* eligible one. Collapsing them would either under-quote every call
 *   or hide the market's floor.
 * - **it degrades instead of failing.** A stake source that throws — an RPC
 *   outage — leaves the column absent and the page up.
 */

const ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;

const WEATHER: Tool = {
  id: 'get_weather',
  name: 'get_weather',
  description: 'Current temperature at a latitude/longitude.',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  verificationPolicyId: 'policy-default',
  tier: ToolTier.VERIFIED,
};

const RATE: Tool = { ...WEATHER, id: 'get_rate', name: 'get_rate', tier: ToolTier.UNVERIFIED };

function binding(overrides: Partial<ToolBindingEntity> = {}): ToolBindingEntity {
  return {
    id: `binding-${Math.random()}`,
    organizationId: 'provider-a',
    toolId: WEATHER.id,
    pricingMode: 'PAID',
    priceAmount: '250000',
    assetId: ASSET,
    status: 'ACTIVE',
    ...overrides,
  } as ToolBindingEntity;
}

function provider(overrides: Partial<ProviderEntity> = {}): ProviderEntity {
  return {
    organizationId: 'provider-a',
    legalName: 'Open-Meteo Demo BV',
    verified: false,
    verifiedAt: null,
    tier: 'NEW',
    status: 'ACTIVE',
    ...overrides,
  } as ProviderEntity;
}

function quote(overrides: Partial<ToolQuote> = {}): ToolQuote {
  return {
    tool: WEATHER,
    price: MoneyUtil.of('250000', ASSET, 6),
    pricingMode: 'PAID',
    routableBindings: 1,
    // Non-empty by default, because the router's own contract makes it so: a
    // candidate whose settleable set is empty is rejected by `filterEligible`,
    // so a quote WITH a price always names at least one chain. A fixture that
    // left this empty beside a price would be a state the platform cannot
    // produce, and every settlement-chain assertion below would be measuring it.
    settlementChains: [CHAIN],
    p95LatencyMs: null,
    qualityRate: null,
    unroutableReason: null,
    ...overrides,
  } as ToolQuote;
}

/** The chain every default fixture here settles on, derived from {@link ASSET}. */
const CHAIN: ChainId = chainIdOf(ASSET as AssetId);
/** A second Solana chain, so "per chain" is expressible without an EVM adapter. */
const OTHER_CHAIN: ChainId = CHAIN_IDS.SOLANA_MAINNET;
const OTHER_ASSET = ASSET_IDS.USDC_SOLANA_MAINNET as AssetId;

interface Wiring {
  readonly bindings?: ToolBindingEntity[];
  readonly providers?: ProviderEntity[];
  readonly tools?: Tool[];
  readonly quality?: Map<string, ProviderQualityCounters>;
  readonly stakeThrows?: boolean;
  readonly quotes?: Record<string, ToolQuote>;
  /**
   * `providerId` → the chains it is enrolled on. Defaults to `[CHAIN]`.
   *
   * **Not optional in spirit, even though it has a default.** `weakestStakes`
   * returns at `keys.length === 0` before it ever calls `stakeOn`, so an empty
   * enrolment map makes the whole method body unreachable — and takes the
   * RPC-degrade case at *"still lists providers when the stake source throws"*
   * with it, because the throw would never fire. Every provider therefore gets
   * at least one enrolment by default.
   */
  readonly enrolledOn?: Readonly<Record<string, readonly ChainId[]>>;
  /** `stakeKey(providerId, chainId)` → staked amount. Absent means "not known". */
  readonly stakesByChain?: Readonly<Record<string, Money>>;
  readonly blocklist?: AccountBlocklistService;
}

function build(wiring: Wiring = {}) {
  const rows = wiring.providers ?? [provider()];

  const bindings = {
    findActiveBindings: jest.fn(async () => wiring.bindings ?? []),
  } as unknown as ToolBindingRepository;

  const providers = {
    findOne: jest.fn(
      async ({ where }: { where: { organizationId: string } }) =>
        rows.find((row) => row.organizationId === where.organizationId) ?? null,
    ),
  } as unknown as ProviderRepository;

  const windows = {
    qualityByProvider: jest.fn(async () => wiring.quality ?? new Map()),
  } as unknown as SlaWindowRepository;

  const router = {
    quote: jest.fn(async (toolId: string) => wiring.quotes?.[toolId] ?? quote()),
  } as unknown as ProviderRouterService;

  // Answers only the pairs it was asked for, from a table keyed the way the
  // port keys it — so a service that asked about the wrong chain gets nothing
  // back rather than the right number by accident.
  const stakes: ProviderStakePort = {
    stakeOn: jest.fn(async (keys: readonly ProviderChainStakeKey[]) => {
      if (wiring.stakeThrows) throw new Error('rpc down');
      const found = new Map<string, ProviderStake>();
      for (const { providerId, chainId } of keys) {
        const staked = (wiring.stakesByChain ?? {})[stakeKey(providerId, chainId)];
        if (staked) {
          found.set(stakeKey(providerId, chainId), {
            providerId,
            chainId,
            staked,
            observedAt: new Date(0),
          });
        }
      }
      return found;
    }),
  };

  // The chain set the catalogue asks stake about comes from the providers'
  // enrolments — a chain with no enrolment has no stake authority to
  // resolve through, so asking about it would be a question with a known
  // answer. Defaulted to one enrolment per provider rather than to an empty
  // map: an empty map short-circuits `weakestStakes` before it reads anything,
  // which is a fixture that makes its own tests unable to fail.
  const enrolments: ChainEnrolmentPort = {
    enrolmentsOf: jest.fn(async (providerIds: readonly string[]) => {
      const found = new Map<string, ChainEnrolment>();
      for (const providerId of providerIds) {
        for (const chainId of wiring.enrolledOn?.[providerId] ?? [CHAIN]) {
          found.set(enrolmentKey(providerId, chainId), {
            providerId,
            chainId,
            payoutAccountId: `${chainId}:PayoutAccount` as AccountId,
            stakeAuthorityAccountId: null,
            status: ChainEnrolmentStatus.ACTIVE,
            enrolledAt: new Date(0),
          });
        }
      }
      return found;
    }),
  };

  const catalogue: ToolCataloguePort = {
    findTool: jest.fn(),
    listTools: jest.fn(async () => wiring.tools ?? [WEATHER, RATE]),
    findBindings: jest.fn(),
  };

  return {
    router,
    stakes,
    enrolments,
    service: new CatalogueService(
      bindings,
      providers,
      windows,
      router,
      stakes,
      enrolments,
      catalogue,
      // The deployment offers both chains, so a two-chain provider's stake is
      // reported as two entries rather than narrowed away by the quote's own
      // chain set.
      [CHAIN, OTHER_CHAIN],
      wiring.blocklist ?? noBlocks(),
    ),
  };
}

describe('GET /catalogue/providers', () => {
  it('lists a provider that has an ACTIVE binding', async () => {
    const { service } = build({ bindings: [binding()] });

    const { providers } = await service.listProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      providerId: 'provider-a',
      legalName: 'Open-Meteo Demo BV',
      toolIds: ['get_weather'],
      activeBindings: 1,
    });
  });

  /**
   * The whole point of the endpoint: the answer does not depend on the caller,
   * so a fresh organization sees the same market as one with a year of
   * receipts. The service takes no organization at all, so these two calls are
   * incapable of diverging — a regression trap that goes red the day somebody
   * scopes it.
   */
  it('answers every caller identically', async () => {
    const { service } = build({ bindings: [binding()] });

    const [first, second] = await Promise.all([service.listProviders(), service.listProviders()]);

    expect(first).toEqual(second);
  });

  it('is empty when nothing is published, without touching the other sources', async () => {
    const { service, stakes } = build({ bindings: [] });

    await expect(service.listProviders()).resolves.toEqual({ providers: [] });
    expect(stakes.stakeOn).not.toHaveBeenCalled();
  });

  it('leaves quality null when no window has closed', async () => {
    const { service } = build({ bindings: [binding()] });

    const { providers } = await service.listProviders();

    expect(providers[0].quality).toBeNull();
  });

  /**
   * The failure mode this exists to prevent: a provider measured on nothing
   * scoring 100% and sorting above one measured at 95% over sixteen thousand
   * calls.
   */
  it('leaves quality null on an empty denominator rather than reporting 100%', async () => {
    const { service } = build({
      bindings: [binding()],
      quality: new Map([
        ['provider-a', { providerId: 'provider-a', verifiedCalls: 0, failedCalls: 0 }],
      ]),
    });

    const { providers } = await service.listProviders();

    expect(providers[0].quality).toBeNull();
  });

  it('reports quality as passed over measured, with the denominator', async () => {
    const { service } = build({
      bindings: [binding()],
      quality: new Map([
        ['provider-a', { providerId: 'provider-a', verifiedCalls: 16800, failedCalls: 840 }],
      ]),
    });

    const { providers } = await service.listProviders();

    expect(providers[0].quality).toEqual({ rate: 0.95, measuredCalls: 16800, failedCalls: 840 });
  });

  it('leaves stake EMPTY when the source does not know — never zero', async () => {
    // The provider IS enrolled and the source IS asked; it simply has no
    // reading. Absent is not zero, and the DTO carries the distinction: an
    // empty list is "we could not say", while a chain that answered zero would
    // appear as a zero-amount entry.
    const { service, stakes } = build({ bindings: [binding()] });

    const { providers } = await service.listProviders();

    expect(providers[0].stake).toEqual([]);
    // …and the read happened. Without this the case above is satisfied by a
    // `weakestStakes` that returns before asking anything, which is what an
    // always-empty enrolment fake used to make it.
    expect(stakes.stakeOn).toHaveBeenCalled();
  });

  it('never presents two chains as one number — not a sum, not one chain\u2019s figure', async () => {
    // **This pins an INVARIANT, deliberately, and not a value.**
    //
    // The card carries one field and a buyer reads it as "how much is behind a
    // call I make here". A call settles on one chain and is backed only by that
    // chain\u2019s collateral, so $90 on one plus $40 on the other is neither $130
    // (a sum advertises protection no single call has) nor $90 nor $40 (either
    // one presented as "the provider\u2019s stake" is one chain\u2019s figure wearing
    // the provider\u2019s name). The two are different CAIP-19 assets, so they
    // cannot be compared to pick the lower either.
    //
    // `null` satisfies this test; a per-chain list satisfies it too, and so
    // does a single figure that names its chain. **Asserting `null` here would
    // mean a better rendering has to delete a passing test to land**, which is
    // exactly the friction that stops it happening.
    //
    // (`null` is a poor long-term answer: this DTO already uses `null` for "the
    // source cannot say", so a provider that stakes on every chain it serves
    // would render identically to one whose RPC is down.)
    //
    // Two SOLANA chain ids and no EVM anywhere: this is a property of the read
    // model, and the read model never learns what a chain is.
    const { service } = build({
      bindings: [binding()],
      enrolledOn: { 'provider-a': [CHAIN, OTHER_CHAIN] },
      stakesByChain: {
        [stakeKey('provider-a', CHAIN)]: MoneyUtil.of('90000000', ASSET, 6),
        [stakeKey('provider-a', OTHER_CHAIN)]: MoneyUtil.of('40000000', OTHER_ASSET, 6),
      },
    });

    const { providers } = await service.listProviders();

    // Shape-tolerant on purpose: a scalar today, a list tomorrow. The amount is
    // extracted only when the field is a single money-shaped object, which is
    // the only shape the three forbidden values could hide in.
    const rendered = providers[0].stake as unknown;
    const asSingleAmount =
      rendered !== null && typeof rendered === 'object' && !Array.isArray(rendered)
        ? (rendered as { amount?: string }).amount
        : undefined;

    expect(asSingleAmount).not.toBe('130000000'); // never a sum
    expect(asSingleAmount).not.toBe('90000000'); // never one chain\u2019s, as the provider\u2019s
    expect(asSingleAmount).not.toBe('40000000');
  });

  it('reports the figure when exactly one chain answered, whichever chain that is', async () => {
    // Enrolled on two, bonded on one. The reading that exists is reported as
    // itself — including when it is the SECOND chain, which a service that took
    // "the first enrolment" would miss.
    const { service } = build({
      bindings: [binding()],
      enrolledOn: { 'provider-a': [CHAIN, OTHER_CHAIN] },
      stakesByChain: {
        [stakeKey('provider-a', OTHER_CHAIN)]: MoneyUtil.of('40000000', OTHER_ASSET, 6),
      },
    });

    const { providers } = await service.listProviders();

    expect(providers[0].stake).toEqual([
      { chainId: OTHER_CHAIN, amount: '40000000', asset: OTHER_ASSET, decimals: 6 },
    ]);
  });

  it('reports two chains as TWO entries, each naming its own chain', async () => {
    // The other side of the invariant above: the provider who stakes on every
    // chain it serves is the best-collateralised
    // participant on the platform, and it renders as two rows — not as `null`,
    // which is what this field says when the source is DOWN.
    const { service } = build({
      bindings: [binding()],
      enrolledOn: { 'provider-a': [CHAIN, OTHER_CHAIN] },
      stakesByChain: {
        [stakeKey('provider-a', CHAIN)]: MoneyUtil.of('90000000', ASSET, 6),
        [stakeKey('provider-a', OTHER_CHAIN)]: MoneyUtil.of('40000000', OTHER_ASSET, 6),
      },
    });

    const { providers } = await service.listProviders();

    expect(providers[0].stake).toHaveLength(2);
    // Each entry names the chain its collateral is actually on, so a reader
    // cannot mistake one chain's figure for the provider's.
    expect(providers[0].stake.map((entry) => entry.chainId).sort()).toEqual(
      [CHAIN, OTHER_CHAIN].sort(),
    );
    for (const entry of providers[0].stake) {
      expect(chainIdOf(entry.asset as AssetId)).toBe(entry.chainId);
    }
  });

  it('asks about every chain the provider is enrolled on, and only those', async () => {
    // The half the assertions above cannot make: a service that asked about one
    // chain would report that chain's figure and look correct whenever it
    // happened to be the only one bonded. What it asked for is the fact, and
    // the length pins that it is not asking about chains nobody declared.
    const { service, stakes } = build({
      bindings: [binding()],
      enrolledOn: { 'provider-a': [CHAIN, OTHER_CHAIN] },
    });

    await service.listProviders();

    expect(stakes.stakeOn).toHaveBeenCalledWith(
      expect.arrayContaining([
        { providerId: 'provider-a', chainId: CHAIN },
        { providerId: 'provider-a', chainId: OTHER_CHAIN },
      ]),
    );
    expect((stakes.stakeOn as jest.Mock).mock.calls[0][0]).toHaveLength(2);
  });

  it('reports stake for a provider who has paused every binding', async () => {
    // `getProvider` renders for a provider with no ACTIVE binding — a buyer
    // reaches this page from a call record as often as from the list. Taking
    // the chain set from the BINDINGS rather than the enrolments would leave
    // exactly that provider with no stake figure.
    const { service } = build({
      bindings: [],
      stakesByChain: { [stakeKey('provider-a', CHAIN)]: MoneyUtil.of('75000000', ASSET, 6) },
    });

    const detail = await service.getProvider('provider-a');

    expect(detail.tools).toEqual([]);
    expect(detail.stake).toEqual([
      { chainId: CHAIN, amount: '75000000', asset: ASSET, decimals: 6 },
    ]);
  });

  /** An RPC outage must cost the stake column, not the page. */
  it('still lists providers when the stake source throws', async () => {
    const { service } = build({ bindings: [binding()], stakeThrows: true });

    const { providers } = await service.listProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0].stake).toEqual([]);
  });

  it('takes the cheapest ACTIVE binding as the floor, comparing as integers', async () => {
    const { service } = build({
      bindings: [
        binding({ priceAmount: '250000' }),
        binding({ priceAmount: '5000', toolId: RATE.id }),
        binding({ priceAmount: '88000', toolId: RATE.id }),
      ],
    });

    const { providers } = await service.listProviders();

    expect(providers[0].fromPrice).toEqual({ amount: '5000', asset: ASSET, decimals: 6 });
    expect(providers[0].toolIds).toEqual(['get_rate', 'get_weather']);
  });

  /**
   * Sorted by measured quality, with the unmeasured below every measured one.
   * "Not measured" is a weaker claim than any rate, including a bad one.
   */
  it('sorts measured providers above unmeasured ones', async () => {
    const { service } = build({
      bindings: [binding(), binding({ organizationId: 'provider-b' })],
      providers: [
        provider(),
        provider({ organizationId: 'provider-b', legalName: 'Northwind Reference Rates' }),
      ],
      quality: new Map([
        ['provider-b', { providerId: 'provider-b', verifiedCalls: 100, failedCalls: 15 }],
      ]),
    });

    const { providers } = await service.listProviders();

    expect(providers.map((row) => row.providerId)).toEqual(['provider-b', 'provider-a']);
  });
});

describe('GET /catalogue/tools', () => {
  it('lists only tools a provider actually serves', async () => {
    const { service } = build({ bindings: [binding()] });

    const { tools } = await service.listTools();

    expect(tools.map((tool) => tool.id)).toEqual(['get_weather']);
  });

  it('counts distinct providers, not bindings', async () => {
    const { service } = build({
      bindings: [
        binding(),
        binding({ organizationId: 'provider-b' }),
        binding({ organizationId: 'provider-b' }),
      ],
    });

    const { tools } = await service.listTools();

    expect(tools[0].providerCount).toBe(2);
  });

  /**
   * `fromPrice` is the market floor; `price` is what a call would be held for,
   * which the router takes as the *dearest* eligible binding so that failover
   * to a costlier provider is covered. Two numbers, and they must not collapse.
   */
  it('reports the floor and the routed quote separately', async () => {
    const { service } = build({
      bindings: [binding({ priceAmount: '5000' }), binding({ priceAmount: '250000' })],
      quotes: { get_weather: quote({ price: MoneyUtil.of('250000', ASSET, 6) }) },
    });

    const { tools } = await service.listTools();

    expect(tools[0].fromPrice).toEqual({ amount: '5000', asset: ASSET, decimals: 6 });
    expect(tools[0].price).toEqual({ amount: '250000', asset: ASSET, decimals: 6 });
  });

  // BUG-R16-B3-03: a screen needs the router's count to say "up to $X" the way
  // tools/list does — providerCount includes a provider the router cannot use.
  it('publishes how many bindings the quote was taken over', async () => {
    const { service } = build({
      bindings: [binding({ priceAmount: '5000' }), binding({ priceAmount: '250000' })],
      quotes: { get_weather: quote({ routableBindings: 1 }) },
    });

    const { tools } = await service.listTools();

    expect(tools[0].routableBindings).toBe(1);
  });

  it('says a tool is unroutable, and why, instead of hiding it', async () => {
    const { service } = build({
      bindings: [binding()],
      quotes: {
        get_weather: quote({
          price: null,
          pricingMode: null,
          unroutableReason: 'every provider is below the minimum stake',
        }),
      },
    });

    const { tools } = await service.listTools();

    expect(tools[0]).toMatchObject({
      routable: false,
      price: null,
      unroutableReason: 'every provider is below the minimum stake',
    });
  });

  /**
   * Where a tool settles, so a buyer holding funds elsewhere is TOLD
   * rather than finding out at `PAYMENT_NO_SETTLEABLE_CHAIN`.
   *
   * Two chains with different ids in every fixture that has any: one chain
   * cannot tell "the union" apart from "the first chain", and the field is
   * asserted as a SET rather than as a value the implementation could produce
   * by naming one of them.
   */
  it('publishes the chains a call would settle on, copied from the router’s own union', async () => {
    const { service } = build({
      bindings: [binding()],
      quotes: { get_weather: quote({ settlementChains: [CHAIN, OTHER_CHAIN] }) },
    });

    const { tools } = await service.listTools();

    expect(tools[0].settlementChains).toEqual([CHAIN, OTHER_CHAIN]);
  });

  it('carries BOTH chains, not just the first — a tool served on two chains', async () => {
    // The degenerate this exists for is "publish the first chain", which a
    // single-chain fixture cannot distinguish from the union.
    const { service } = build({
      bindings: [binding()],
      quotes: { get_weather: quote({ settlementChains: [OTHER_CHAIN, CHAIN] }) },
    });

    const { tools } = await service.listTools();

    expect(tools[0].settlementChains).toHaveLength(2);
    expect(tools[0].settlementChains).toContain(CHAIN);
    expect(tools[0].settlementChains).toContain(OTHER_CHAIN);
  });

  it('says UNKNOWN — null, never [] — for a tool nothing can route right now', async () => {
    // The false negative this refuses: `[]` reads as "settles nowhere you can
    // pay", so a buyer would be told to give up on a tool whose supply is
    // merely under-staked today. `routable: false` plus `unroutableReason` is
    // the honest account of it, and `settlementChains` has nothing to add.
    const { service } = build({
      bindings: [binding()],
      quotes: {
        get_weather: quote({
          price: null,
          pricingMode: null,
          settlementChains: [],
          unroutableReason: 'every provider is below the minimum stake',
        }),
      },
    });

    const { tools } = await service.listTools();

    expect(tools[0].routable).toBe(false);
    expect(tools[0].settlementChains).toBeNull();
    // Named explicitly: `toBeNull()` alone passes on `undefined` in some
    // matchers' hands, and `[]` is the value this case is actually about.
    expect(tools[0].settlementChains).not.toEqual([]);
  });

  it('spells the field the way `tools/list` spells it, with CAIP-2 values', async () => {
    // One fact, one name, one derivation. `McpCatalogueService` publishes
    // `x402/settlementChains` from `quote.settlementChains`; this publishes
    // `settlementChains` from the same expression. Asserting the KEY is what
    // stops the two surfaces from being renamed apart.
    const { service } = build({
      bindings: [binding()],
      quotes: { get_weather: quote({ settlementChains: [CHAIN, OTHER_CHAIN] }) },
    });

    const { tools } = await service.listTools();

    expect(Object.keys(tools[0])).toContain('settlementChains');
    expect(X402_SETTLEMENT_CHAINS).toBe('x402/settlementChains');
    for (const chainId of tools[0].settlementChains ?? []) {
      expect(chainId).toMatch(CHAIN_ID_RE);
    }
  });

  it('lists every other tool when one tool’s quote throws (BUG-J-BUY-05)', async () => {
    // One tool's catalogue defect is that tool's alone. A single
    // `Promise.all` turned it into a 500 for the whole shop.
    const { service, router } = build({
      bindings: [binding(), binding({ toolId: RATE.id })],
    });
    (router.quote as jest.Mock).mockImplementation(async (toolId: string) => {
      if (toolId === RATE.id) throw new Error('catalogue defect');
      return quote();
    });

    const { tools } = await service.listTools();

    expect(tools.find((tool) => tool.id === WEATHER.id)).toMatchObject({ routable: true });
    expect(tools.find((tool) => tool.id === RATE.id)).toMatchObject({
      routable: false,
      price: null,
      settlementChains: null,
    });
  });

  /** `quote()` does not consume a ceiling token, so browsing cannot exhaust a provider. */
  it('quotes each listed tool exactly once', async () => {
    const { service, router } = build({
      bindings: [binding(), binding({ toolId: RATE.id })],
    });

    await service.listTools();

    expect(router.quote).toHaveBeenCalledTimes(2);
  });
});

describe('GET /catalogue/providers/:providerId', () => {
  it('names each tool the provider serves', async () => {
    const { service } = build({ bindings: [binding()] });

    const detail = await service.getProvider('provider-a');

    expect(detail.tools).toEqual([
      {
        toolId: 'get_weather',
        name: 'get_weather',
        pricingMode: 'PAID',
        price: { amount: '250000', asset: ASSET, decimals: 6 },
      },
    ]);
  });

  /**
   * A provider who paused every binding is absent from the list but must still
   * render — a buyer reaches this page from a call record as often as from the
   * list.
   */
  it('answers for a registered provider that publishes nothing', async () => {
    const { service } = build({ bindings: [] });

    const detail = await service.getProvider('provider-a');

    expect(detail.tools).toEqual([]);
    expect(detail.activeBindings).toBe(0);
  });

  /** 404, never 403 — a 403 would confirm the id exists. */
  it('404s on an unknown provider', async () => {
    const { service } = build({ bindings: [] });

    await expectErrorCodeAsync(
      () => service.getProvider('nobody'),
      ProviderErrorCode.PROVIDER_NOT_FOUND,
    );
  });
});

describe('the catalogue, with a provider blocked', () => {
  const OPEN = '0a6f3c1e-7d8b-4e2a-9c5f-1b3d5e7f9a11';
  const BLOCKED = '5c0b3b4e-0d8a-4f6e-9a51-6f1d2b7c9e10';
  const wiring = (): Wiring => ({
    bindings: [binding({ organizationId: OPEN }), binding({ organizationId: BLOCKED })],
    providers: [
      provider({ organizationId: OPEN }),
      provider({ organizationId: BLOCKED, legalName: 'Blocked BV' }),
    ],
    blocklist: blocklistOf({ kind: BlockSubjectKind.ORGANIZATION, subject: BLOCKED }),
  });

  it('leaves the blocked provider out of the provider list', async () => {
    const { service } = build(wiring());

    const { providers } = await service.listProviders();

    expect(providers.map((row) => row.providerId)).toEqual([OPEN]);
  });

  it('does not count the blocked provider behind a tool', async () => {
    const { service } = build(wiring());

    const { tools } = await service.listTools();

    expect(tools[0].providerCount).toBe(1);
  });

  it('still answers for the blocked provider, with no tools', async () => {
    const { service } = build(wiring());

    const detail = await service.getProvider(BLOCKED);

    expect(detail.tools).toEqual([]);
  });
});
