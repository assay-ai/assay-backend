import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import {
  OnEmpty,
  ProviderMode,
  RuleRejectionReason,
  RuleSource,
  RoutingContext,
} from '@modules/tool/domain/routing';
import { ToolAccessErrorCode } from '@modules/tool/errors/tool-access.errors';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { PricingMode } from '@modules/tool/ports/tool.types';

import { addBlock, blocklistOf } from '../helpers/blocklist';
import {
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildProvider,
  buildRouter,
  ok,
  routingContext,
  seededRandom,
  status,
  usdc,
} from './helpers/routing-fixtures';

// Organization ids: the blocklist only matches a UUID organization subject.
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

const bindings = [
  buildBinding(A),
  buildBinding(B, { priceAmount: usdc('0.08').amount }),
  buildBinding(C, { pricingMode: PricingMode.FREE, priceAmount: '0' }),
];
const providers = [buildProvider(A), buildProvider(B), buildProvider(C)];

function harness(
  options: {
    blocklist?: AccountBlocklistService;
    script?: ConstructorParameters<typeof ScriptedInvoker>[0];
    random?: () => number;
  } = {},
) {
  const blocklist = options.blocklist ?? blocklistOf();
  const invoker = new ScriptedInvoker(
    options.script ?? {
      [`binding-${A}`]: async () => ok('a'),
      [`binding-${B}`]: async () => ok('b'),
      [`binding-${C}`]: async () => ok('c'),
    },
  );
  const built = buildRouter({
    bindings,
    providers,
    stakes: { [A]: usdc(1000), [B]: usdc(1000) },
    invoker,
    blocklist,
    random: options.random,
  });
  return { ...built, invoker, blocklist };
}

const block = (organizationId: string) => ({
  kind: BlockSubjectKind.ORGANIZATION,
  subject: organizationId,
});

/** Lift a block the way the operator service does, after its commit. */
async function unblock(blocklist: AccountBlocklistService, organizationId: string): Promise<void> {
  await blocklist.applied({
    kind: 'unblocked',
    subjectKind: BlockSubjectKind.ORGANIZATION,
    subjectKey: organizationId,
  });
}

const PAID = routingContext({ callClass: 'PAID' });
const FREE = routingContext({ callClass: 'FREE' });

const call = (context: RoutingContext, callId = 'call-1') => ({
  toolId: TOOL_ID,
  callId,
  input: { query: 'x' },
  context,
});

describe('routing — the account blocklist', () => {
  describe('with no blocks, quote() is unchanged', () => {
    it('quotes a whole-supply, a paid and a free call exactly as before', async () => {
      const { router } = harness();
      const quotes = await Promise.all([
        router.quote(TOOL_ID, routingContext()),
        router.quote(TOOL_ID, routingContext({ callClass: 'PAID' })),
        router.quote(TOOL_ID, routingContext({ callClass: 'FREE' })),
      ]);
      expect(quotes.map((quote) => ({ ...quote, tool: quote?.tool.id }))).toMatchInlineSnapshot(`
        [
          {
            "cheapestPrice": {
              "amount": "50000",
              "asset": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
              "decimals": 6,
            },
            "freeBindings": [
              {
                "freeDailyBudget": null,
                "freeQuotaPerAgent": null,
              },
            ],
            "listings": 2,
            "p95LatencyMs": 800.0000000000001,
            "paidBindings": 2,
            "price": {
              "amount": "80000",
              "asset": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
              "decimals": 6,
            },
            "pricedBy": [
              "00000000-0000-4000-8000-00000000000b",
            ],
            "pricingMode": "FREEMIUM",
            "qualityRate": 0.9319867155745019,
            "routableBindings": 3,
            "settlementChains": [
              "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            ],
            "tool": "search_web",
            "unroutableReason": null,
          },
          {
            "cheapestPrice": {
              "amount": "50000",
              "asset": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
              "decimals": 6,
            },
            "freeBindings": [],
            "listings": 2,
            "p95LatencyMs": 800,
            "paidBindings": 2,
            "price": {
              "amount": "80000",
              "asset": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
              "decimals": 6,
            },
            "pricedBy": [
              "00000000-0000-4000-8000-00000000000b",
            ],
            "pricingMode": "PAID",
            "qualityRate": 0.95,
            "routableBindings": 2,
            "settlementChains": [
              "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            ],
            "tool": "search_web",
            "unroutableReason": null,
          },
          {
            "cheapestPrice": null,
            "freeBindings": [
              {
                "freeDailyBudget": null,
                "freeQuotaPerAgent": null,
              },
            ],
            "listings": 1,
            "p95LatencyMs": 800,
            "paidBindings": 0,
            "price": {
              "amount": "0",
              "asset": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
              "decimals": 6,
            },
            "pricedBy": [
              "00000000-0000-4000-8000-00000000000c",
            ],
            "pricingMode": "FREE",
            "qualityRate": 0.9,
            "routableBindings": 1,
            "settlementChains": [
              "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            ],
            "tool": "search_web",
            "unroutableReason": null,
          },
        ]
      `);
    });
  });

  describe('quote', () => {
    it('never quotes a blocked provider: price, pricedBy and listings come from the rest', async () => {
      // B is the unique dearest, so it would set the price and be named in pricedBy.
      const { router } = harness({ blocklist: blocklistOf(block(B)) });

      const quote = await router.quote(TOOL_ID, PAID);
      expect(quote).toMatchObject({
        price: usdc('0.05'),
        pricedBy: [A],
        listings: 1,
        paidBindings: 1,
        routableBindings: 1,
        cheapestPrice: usdc('0.05'),
      });
      expect(JSON.stringify(quote)).not.toContain(B);
    });

    it('does not name a blocked provider in the reason a quote is unroutable', async () => {
      const { router } = harness({ blocklist: blocklistOf(block(A), block(B)) });

      const quote = await router.quote(TOOL_ID, PAID);
      expect(quote).toMatchObject({ price: null, routableBindings: 0 });
      expect(JSON.stringify(quote)).not.toContain(A);
      expect(JSON.stringify(quote)).not.toContain(B);
    });

    it('drops a blocked provider from the free class too', async () => {
      const { router, invoker } = harness({ blocklist: blocklistOf(block(C)) });

      expect(await router.quote(TOOL_ID, FREE)).toMatchObject({ price: null, routableBindings: 0 });
      // The whole-supply quote no longer counts C's free binding.
      expect(await router.quote(TOOL_ID, routingContext())).toMatchObject({
        pricingMode: PricingMode.PAID,
        freeBindings: [],
        routableBindings: 2,
      });
      await expect(router.route(call(FREE))).rejects.toMatchObject({
        errorCode: ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING,
      });
      expect(invoker.invocations).toHaveLength(0);
    });

    it('applies a block to a snapshot gathered before it, and lifts it the same way', async () => {
      // The quote index prices from a snapshot up to a minute old, and a block
      // does not invalidate it: the live blocklist is applied at pricing time.
      const { router, blocklist } = harness();
      const tool = (await router.quote(TOOL_ID, PAID))!.tool;
      const snapshot = await router.snapshotCandidates(TOOL_ID);

      addBlock(blocklist, block(B));
      expect(router.quoteFromCandidates(tool, snapshot, PAID)).toMatchObject({
        price: usdc('0.05'),
        pricedBy: [A],
      });

      await unblock(blocklist, B);
      expect(router.quoteFromCandidates(tool, snapshot, PAID)).toMatchObject({
        price: usdc('0.08'),
        pricedBy: [B],
        listings: 2,
      });
    });
  });

  describe('offer and route', () => {
    it('never offers or routes to a blocked provider', async () => {
      const { router, invoker } = harness({
        blocklist: blocklistOf(block(A)),
        random: seededRandom(7),
      });

      for (let index = 0; index < 50; index += 1) {
        expect((await router.offer(TOOL_ID, PAID)).providerId).toBe(B);
        expect((await router.route(call(PAID, `call-${index}`))).providerId).toBe(B);
      }
      expect(new Set(invoker.providerIds)).toEqual(new Set([B]));
    });

    it('refuses when every provider of the class is blocked, without naming them', async () => {
      const { router, invoker } = harness({ blocklist: blocklistOf(block(A), block(B)) });

      const offered = await router.offer(TOOL_ID, PAID).catch((error: unknown) => error);
      expect(offered).toMatchObject({ errorCode: ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING });
      expect(JSON.stringify(offered)).not.toContain(A);
      expect(JSON.stringify(offered)).not.toContain(B);

      await expect(router.route(call(PAID))).rejects.toMatchObject({
        errorCode: ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING,
      });
      expect(invoker.invocations).toHaveLength(0);
    });

    it('leaves a blocked provider out of a rule refusal', async () => {
      // The agent excludes A; B is blocked. The refusal names A alone.
      const { router } = harness({ blocklist: blocklistOf(block(B)) });
      const refusal = await router
        .offer(TOOL_ID, {
          ...PAID,
          rules: {
            agent: { excludeProviderIds: [A], maxPrice: null, minTier: null, minQuality: null },
            entry: null,
          },
        })
        .catch((error: unknown) => error);
      expect(refusal).toMatchObject({ errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES });
      expect(
        (refusal as { context: { details: { providers: { providerId: string }[] } } }).context
          .details.providers,
      ).toEqual([expect.objectContaining({ providerId: A })]);
    });

    it('does not fall back onto a blocked provider (FALLBACK_BEST)', async () => {
      // random() near 1 draws the last entry, which would be B.
      const { router } = harness({ blocklist: blocklistOf(block(B)), random: () => 0.999 });
      const offer = await router.offer(TOOL_ID, {
        ...PAID,
        rules: {
          agent: null,
          entry: {
            mode: ProviderMode.ONLY,
            providerIds: [C],
            minTier: null,
            maxPrice: null,
            minQuality: null,
            onEmpty: OnEmpty.FALLBACK_BEST,
          },
        },
      });
      expect(offer).toMatchObject({ providerId: A, fellBack: true });
    });
  });

  describe('failover', () => {
    it('skips a blocked provider when the first one fails', async () => {
      const { router, invoker } = harness({
        blocklist: blocklistOf(block(B)),
        script: {
          [`binding-${A}`]: async () => status(503),
          [`binding-${B}`]: async () => ok('b'),
        },
      });

      await expect(router.route(call(PAID))).rejects.toMatchObject({
        errorCode: ToolErrorCode.TOOL_ALL_BINDINGS_FAILED,
      });
      expect(invoker.providerIds).toEqual([A]);
    });

    it('skips a provider blocked while the call is failing over', async () => {
      const blocklist = blocklistOf();
      const { router, invoker } = harness({
        blocklist,
        script: {
          // The first draw is A (the first entry). B is blocked while A runs.
          [`binding-${A}`]: async () => {
            addBlock(blocklist, block(B));
            return status(503);
          },
          [`binding-${B}`]: async () => ok('b'),
        },
      });

      await expect(router.route(call(PAID))).rejects.toMatchObject({
        errorCode: ToolErrorCode.TOOL_ALL_BINDINGS_FAILED,
      });
      expect(invoker.providerIds).toEqual([A]);
    });
  });

  describe('rail B pin (onlyProviderId)', () => {
    it('refuses a pin on a blocked provider as PAYEE_NO_LONGER_ELIGIBLE, in offer and route', async () => {
      const { router, invoker } = harness({ blocklist: blocklistOf(block(B)) });
      const pinned = { ...PAID, onlyProviderId: B };

      const refusal = await router.offer(TOOL_ID, pinned).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES });
      expect((refusal as { context: { details: unknown } }).context.details).toEqual({
        toolId: TOOL_ID,
        providers: [
          expect.objectContaining({
            providerId: B,
            reason: RuleRejectionReason.PAYEE_NO_LONGER_ELIGIBLE,
            source: RuleSource.REQUEST,
          }),
        ],
      });

      await expect(router.route(call(pinned))).rejects.toMatchObject({
        errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES,
      });
      expect(invoker.invocations).toHaveLength(0);
    });

    it('serves the pin again once the block is lifted', async () => {
      const { router, blocklist } = harness({ blocklist: blocklistOf(block(B)) });
      const pinned = { ...PAID, onlyProviderId: B };
      await expect(router.offer(TOOL_ID, pinned)).rejects.toMatchObject({
        errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES,
      });

      await unblock(blocklist, B);
      await expect(router.offer(TOOL_ID, pinned)).resolves.toMatchObject({ providerId: B });
      await expect(router.route(call(pinned))).resolves.toMatchObject({ providerId: B });
    });
  });

  describe('unblocking', () => {
    it('restores the provider to the quote, the offer and routing', async () => {
      const { router, blocklist } = harness({ blocklist: blocklistOf(block(A)) });
      expect((await router.quote(TOOL_ID, PAID))!.listings).toBe(1);

      await unblock(blocklist, A);
      const quote = await router.quote(TOOL_ID, PAID);
      expect(quote).toMatchObject({ listings: 2, cheapestPrice: usdc('0.05') });
      // The first entry is A, drawn with random() = 0.
      expect((await router.offer(TOOL_ID, PAID)).providerId).toBe(A);
      expect((await router.route(call(PAID))).providerId).toBe(A);
    });

    it('a blocked organization outside the pool changes nothing', async () => {
      const unrelated = '00000000-0000-4000-8000-0000000000ff';
      const clean = harness();
      const blocked = harness({ blocklist: blocklistOf(block(unrelated)) });
      for (const context of [routingContext(), PAID, FREE]) {
        expect(await blocked.router.quote(TOOL_ID, context)).toEqual(
          await clean.router.quote(TOOL_ID, context),
        );
      }
    });
  });
});
