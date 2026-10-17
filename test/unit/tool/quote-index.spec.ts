import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { ProviderRouterService } from '@modules/tool/services/provider-router.service';
import {
  QUOTE_INDEX_EPOCH_KEY,
  QUOTE_INDEX_MAX_AGE_MS,
  QuoteIndexService,
} from '@modules/tool/services/quote-index.service';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import {
  ROUTING_CONTEXT,
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildProvider,
  buildRouter,
  buildTool,
  usdc,
} from './helpers/routing-fixtures';

/**
 * The quote index (design spec §7.4, NFR-2): a listing prices from cached
 * candidates — no registry or chain read per tool per list — refreshed at
 * least every minute and at once after a binding write.
 */
describe('QuoteIndexService', () => {
  function build() {
    const tool = buildTool();
    const bindings = [buildBinding('p1'), buildBinding('p2', { priceAmount: usdc('0.02').amount })];
    const { router } = buildRouter({
      tool,
      bindings,
      providers: [buildProvider('p1'), buildProvider('p2')],
      stakes: { p1: usdc(1000), p2: usdc(1000) },
      invoker: new ScriptedInvoker({}),
    });
    const gathers = jest.spyOn(router, 'snapshotCandidates');
    let now = 1_000_000;
    let epoch: string | null = '1';
    const cache = {
      getRaw: jest.fn(async (key: string) => (key === QUOTE_INDEX_EPOCH_KEY ? epoch : null)),
      getRedisClient: () => ({ incr: async () => (epoch = String(Number(epoch) + 1)) }),
    } as unknown as CacheService;
    const index = new QuoteIndexService(
      router as ProviderRouterService,
      new InMemoryToolCatalogue({ tools: [tool], bindings }),
      cache,
      () => now,
    );
    return {
      index,
      gathers,
      advance: (ms: number) => (now += ms),
      setEpoch: (value: string | null) => (epoch = value),
    };
  }

  it('prices like router.quote, from one snapshot for many listings', async () => {
    const { index, gathers } = build();
    const first = await index.quote(TOOL_ID, ROUTING_CONTEXT);
    await index.quote(TOOL_ID, ROUTING_CONTEXT);
    await index.quote(TOOL_ID, { ...ROUTING_CONTEXT, rules: { agent: null, entry: null } });

    expect(first?.routableBindings).toBe(2);
    expect(first?.cheapestPrice).toEqual(usdc('0.02'));
    expect(gathers).toHaveBeenCalledTimes(1);
  });

  it('prices each viewer under its own rules from the same snapshot', async () => {
    const { index, gathers } = build();
    const quotes = await index.quoteMany([TOOL_ID], () => ({
      ...ROUTING_CONTEXT,
      rules: {
        agent: { excludeProviderIds: ['p2'], maxPrice: null, minTier: null, minQuality: null },
        entry: null,
      },
    }));
    expect(quotes.get(TOOL_ID)?.routableBindings).toBe(1);
    expect(gathers).toHaveBeenCalledTimes(1);
  });

  it('reloads a snapshot older than a minute', async () => {
    const { index, gathers, advance } = build();
    await index.quote(TOOL_ID, ROUTING_CONTEXT);
    advance(QUOTE_INDEX_MAX_AGE_MS - 1);
    await index.quote(TOOL_ID, ROUTING_CONTEXT);
    advance(2);
    await index.quote(TOOL_ID, ROUTING_CONTEXT);
    expect(gathers).toHaveBeenCalledTimes(2);
  });

  it('reloads at once when a binding write bumped the epoch, in any process', async () => {
    const { index, gathers, setEpoch } = build();
    await index.quote(TOOL_ID, ROUTING_CONTEXT);
    setEpoch('2');
    await index.quote(TOOL_ID, ROUTING_CONTEXT);
    expect(gathers).toHaveBeenCalledTimes(2);

    await index.bumpEpoch();
    await index.quote(TOOL_ID, ROUTING_CONTEXT);
    expect(gathers).toHaveBeenCalledTimes(3);
  });

  it('shares one load among concurrent listings', async () => {
    const { index, gathers } = build();
    await Promise.all([1, 2, 3].map(() => index.quote(TOOL_ID, ROUTING_CONTEXT)));
    expect(gathers).toHaveBeenCalledTimes(1);
  });

  it('a tool whose snapshot fails is unpriced alone', async () => {
    const { index, gathers } = build();
    gathers.mockRejectedValueOnce(new Error('stake source down'));
    const quotes = await index.quoteMany([TOOL_ID, 'unknown-tool'], () => ROUTING_CONTEXT);
    expect(quotes.get(TOOL_ID)).toBeNull();
    expect(quotes.get('unknown-tool')).toBeNull();
    expect((await index.quote(TOOL_ID, ROUTING_CONTEXT))?.routableBindings).toBe(2);
  });
});
