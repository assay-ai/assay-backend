import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { AppError } from '@shared/errors/app-errors';

import {
  ROUTING_CONTEXT,
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildProvider,
  buildRouter,
  ok,
  routingContext,
  seededRandom,
  usdc,
} from './helpers/routing-fixtures';

/**
 * Which supply may serve which call, and what the quote and the offer say.
 *
 * - A paid call is served only by a paid binding (`PAID` or `FREEMIUM`) of a
 *   provider that passed the stake floor. A `FREE` binding is exempt from that
 *   floor and from the payout gate, so it must never take a call that is charged.
 * - A free call is served only by a `FREE` or `FREEMIUM` binding — never by a
 *   `PAID` one, whose provider would serve with no intent and be paid nothing.
 * - The quote is `FREEMIUM` whenever free-capable supply (`FREE` or
 *   `FREEMIUM`) sits beside paid supply (`PAID` or `FREEMIUM`): the call is
 *   free first, inside the agent's quota, then paid. `PAID` only when nothing
 *   eligible can serve a free call, `FREE` only when nothing can be charged.
 * - The rail-B offer carries the offered binding's own price, which is what the
 *   voucher is signed for.
 */
describe('routing by call class', () => {
  const A = 'provider-a';
  const B = 'provider-b';

  const call = (callClass?: 'FREE' | 'PAID') => ({
    toolId: TOOL_ID,
    callId: 'test-call-id',
    input: { query: 'x' },
    context: routingContext({ callClass }),
  });

  it('never routes a paid call to a FREE binding, even from an unbonded provider', async () => {
    const invoker = new ScriptedInvoker({
      'binding-provider-a': async () => ok('free'),
      'binding-provider-b': async () => ok('paid'),
    });
    const { router } = buildRouter({
      bindings: [
        buildBinding(A, { pricingMode: PricingMode.FREE, priceAmount: '0' }),
        buildBinding(B),
      ],
      providers: [buildProvider(A), buildProvider(B)],
      // A has no stake at all: the FREE exemption is the only thing admitting it.
      stakes: { [B]: usdc(1000) },
      invoker,
      random: seededRandom(11),
    });

    for (let index = 0; index < 100; index += 1) {
      expect((await router.route(call('PAID'))).providerId).toBe(B);
    }
  });

  it('refuses a paid call when only FREE bindings are routable', async () => {
    const { router } = buildRouter({
      bindings: [buildBinding(A, { pricingMode: PricingMode.FREE, priceAmount: '0' })],
      providers: [buildProvider(A)],
      stakes: {},
      invoker: new ScriptedInvoker({ 'binding-provider-a': async () => ok() }),
    });

    const refusal = await router.route(call('PAID')).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(AppError);
    expect((refusal as AppError).errorCode).toBe(ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING);
  });

  it('never routes a free call to a PAID binding', async () => {
    const invoker = new ScriptedInvoker({
      'binding-provider-a': async () => ok('freemium'),
      'binding-provider-b': async () => ok('paid'),
    });
    const { router } = buildRouter({
      bindings: [buildBinding(A, { pricingMode: PricingMode.FREEMIUM }), buildBinding(B)],
      providers: [buildProvider(A), buildProvider(B)],
      stakes: { [A]: usdc(1000), [B]: usdc(1000) },
      invoker,
      random: seededRandom(5),
    });

    for (let index = 0; index < 100; index += 1) {
      expect((await router.route(call('FREE'))).providerId).toBe(A);
    }
  });

  it('quotes FREEMIUM when a FREEMIUM binding sits beside a PAID one, in either order', async () => {
    for (const order of [
      [buildBinding(A, { pricingMode: PricingMode.FREEMIUM }), buildBinding(B)],
      [buildBinding(B), buildBinding(A, { pricingMode: PricingMode.FREEMIUM })],
    ]) {
      const { router } = buildRouter({
        bindings: order,
        providers: [buildProvider(A), buildProvider(B)],
        stakes: { [A]: usdc(1000), [B]: usdc(1000) },
        invoker: new ScriptedInvoker({}),
      });

      const quote = await router.quote(TOOL_ID, ROUTING_CONTEXT);
      expect(quote?.pricingMode).toBe(PricingMode.FREEMIUM);
    }
  });

  it('quotes FREEMIUM for FREE beside PAID, priced at the paid binding alone', async () => {
    const { router } = buildRouter({
      bindings: [
        buildBinding(A, { pricingMode: PricingMode.FREE, priceAmount: '0' }),
        buildBinding(B, { priceAmount: usdc('0.02').amount }),
      ],
      providers: [buildProvider(A), buildProvider(B)],
      // A has no stake: the FREE exemption admits it for free calls only.
      stakes: { [B]: usdc(1000) },
      invoker: new ScriptedInvoker({}),
    });

    const quote = await router.quote(TOOL_ID, ROUTING_CONTEXT);
    expect(quote?.pricingMode).toBe(PricingMode.FREEMIUM);
    // The hold is the paid supply's price: a FREE binding is never charged for.
    expect(quote?.price).toEqual(usdc('0.02'));
  });

  it('quotes PAID when no eligible binding can serve a free call', async () => {
    const { router } = buildRouter({
      bindings: [buildBinding(A), buildBinding(B)],
      providers: [buildProvider(A), buildProvider(B)],
      stakes: { [A]: usdc(1000), [B]: usdc(1000) },
      invoker: new ScriptedInvoker({}),
    });

    const quote = await router.quote(TOOL_ID, ROUTING_CONTEXT);
    expect(quote?.pricingMode).toBe(PricingMode.PAID);
  });

  it('quotes FREE when nothing eligible can be charged', async () => {
    const { router } = buildRouter({
      bindings: [buildBinding(A, { pricingMode: PricingMode.FREE, priceAmount: '0' })],
      providers: [buildProvider(A)],
      stakes: {},
      invoker: new ScriptedInvoker({}),
    });

    const quote = await router.quote(TOOL_ID, ROUTING_CONTEXT);
    expect(quote?.pricingMode).toBe(PricingMode.FREE);
  });

  it('quotes PAID when the only free-capable binding is ineligible', async () => {
    const { router } = buildRouter({
      // A is FREEMIUM, so it is gated as paid, and it has no stake.
      bindings: [buildBinding(A, { pricingMode: PricingMode.FREEMIUM }), buildBinding(B)],
      providers: [buildProvider(A), buildProvider(B)],
      stakes: { [B]: usdc(1000) },
      invoker: new ScriptedInvoker({}),
    });

    const quote = await router.quote(TOOL_ID, ROUTING_CONTEXT);
    expect(quote?.pricingMode).toBe(PricingMode.PAID);
  });

  it('offers the price of the binding it offers, not the dearest one', async () => {
    const { router } = buildRouter({
      bindings: [
        buildBinding(A, { priceAmount: usdc('0.05').amount }),
        buildBinding(B, { priceAmount: usdc('0.10').amount }),
      ],
      providers: [buildProvider(A), buildProvider(B)],
      stakes: { [A]: usdc(1000), [B]: usdc(1000) },
      invoker: new ScriptedInvoker({}),
    });

    const quote = await router.quote(TOOL_ID, ROUTING_CONTEXT);
    expect(quote?.price).toEqual(usdc('0.10'));

    const offer = await router.offer(
      TOOL_ID,
      routingContext({ callClass: 'PAID', onlyProviderId: A }),
    );
    expect(offer.providerId).toBe(A);
    expect(offer.price).toEqual(usdc('0.05'));
  });
});
