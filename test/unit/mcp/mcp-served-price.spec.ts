import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';

import {
  ScriptedInvoker,
  buildBinding,
  buildProvider,
  ok,
  status,
  usdc,
} from '../tool/helpers/routing-fixtures';
import { SESSION, buildMcpHarness } from './helpers/mcp-harness';

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
