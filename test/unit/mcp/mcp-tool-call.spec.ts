import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  MCP_UNROUTABLE_REASON,
  MCP_VERIFICATION_ENQUEUE_FAILED_REASON,
} from '@modules/mcp/constants/mcp.constants';
import { ResponseClass } from '@modules/tool/domain/classification';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { McpFailureCode } from '@modules/mcp/services/mcp-tool-call.service';
import { PaymentIntentStatus, PaymentRail } from '@modules/payment/ports/payment.types';
import { ProviderStatus } from '@modules/provider/ports/provider.types';
import { AppError } from '@shared/errors/app-errors';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import {
  InvokerScript,
  ScriptedInvoker,
  buildBinding,
  buildProvider,
  hang,
  jsonResponse,
  ok,
  PAYOUT_ACCOUNT,
  PAYOUT_CHAIN,
  status,
  usdc,
} from '../tool/helpers/routing-fixtures';
import { McpHarnessOptions, SESSION, buildMcpHarness } from './helpers/mcp-harness';

/**
 * `tools/call` — the loop, and the order it happens in.
 *
 * Almost every assertion here is about **sequence**, not about a return value.
 * The money-safety properties of this milestone are all orderings: the hold is
 * open before a provider is called, a call that cannot be paid for never
 * reaches a provider at all, and — since the verification worker — the hold is never committed
 * or released on this path at all for a `DATA_RESULT` that passed the tool's
 * `outputSchema`. That decision now belongs entirely to
 * `VerificationSettlementService`'s worker; this suite's job is to prove the
 * call durably hands the intent off to it (`FakeSettlement`) rather than
 * deciding anything itself. The one exception — a `DATA_RESULT` whose
 * payload failed the schema — is still decided here, synchronously, because
 * the schema layer already answered that question before `resolveDataResult`
 * ever runs.
 */
describe('McpToolCallService — the paid call loop', () => {
  const ARGS = { query: 'moon landing' };

  function harness(
    script: Readonly<Record<string, InvokerScript>>,
    overrides: Partial<McpHarnessOptions> = {},
  ) {
    return buildMcpHarness({
      bindings: [buildBinding('provider-a')],
      providers: [buildProvider('provider-a')],
      invoker: new ScriptedInvoker(script),
      ...overrides,
    });
  }

  // ── The happy path ────────────────────────────────────────────────────────

  it('returns the mapped output and a receipt in VERIFYING', async () => {
    const { calls } = harness({ 'binding-provider-a': () => Promise.resolve(ok('forty-two')) });

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('RESULT');
    if (outcome.kind !== 'RESULT') return;

    expect(outcome.output).toEqual({ answer: 'forty-two' });
    // E2E (EVM run, E4): before the verdict the price is held, not charged —
    // a DATA_FAIL refunds it a second later, and the agent must not be holding
    // a receipt that says "charged" for that call.
    expect(outcome.receipt.charged.amount).toBe('0');
    expect(outcome.receipt.held.amount).toBe(usdc('0.05').amount);
    expect(outcome.receipt.classification).toBe(ResponseClass.DATA_RESULT);
    expect(outcome.receipt.providerId).toBe('provider-a');
    // Nobody has judged this call yet. The receipt says so.
    expect(outcome.receipt.status).toBe(PaymentIntentStatus.VERIFYING);
  });

  /**
   * The ordering the whole milestone rests on.
   *
   * `HOLD_CREATE` is recorded by the ledger fake and the provider call is
   * recorded by the invoker; both carry an index, so "the hold came first" is
   * checkable rather than assumed. Nothing after `HOLD_CREATE` touches the
   * ledger on this path any more — the hold's resolution moved onto
   * `VerificationSettlementService`'s worker, which this test never runs.
   */
  it('opens the hold before the provider is called, and leaves it open', async () => {
    const order: string[] = [];
    const { calls, ledger } = harness({
      'binding-provider-a': () => {
        order.push('PROVIDER_CALLED');
        return Promise.resolve(ok());
      },
    });

    await calls.call(SESSION, 'Search the web', ARGS);

    expect(ledger.kinds[0]).toBe('HOLD_CREATE');
    expect(order).toEqual(['PROVIDER_CALLED']);
    expect(ledger.kinds).toEqual(['HOLD_CREATE']);
  });

  it('walks the intent through every state this path is responsible for', async () => {
    const { calls, intents } = harness({ 'binding-provider-a': () => Promise.resolve(ok()) });

    await calls.call(SESSION, 'Search the web', ARGS);

    expect(intents.transitions).toEqual([
      `→ ${PaymentIntentStatus.CREATED}`,
      `→ ${PaymentIntentStatus.FUNDS_SECURED}`,
      `→ ${PaymentIntentStatus.PROVIDER_EXECUTING}`,
      `→ ${PaymentIntentStatus.VERIFYING}`,
    ]);
  });

  it('durably hands a schema-valid DATA_RESULT to the verification worker', async () => {
    const { calls, intents, settlement } = harness({
      'binding-provider-a': () => Promise.resolve(ok('forty-two')),
    });

    await calls.call(SESSION, 'Search the web', ARGS);

    expect(settlement.calls).toHaveLength(1);
    const [enqueued] = settlement.calls;
    expect(enqueued.organizationId).toBe(SESSION.organizationId);
    expect(enqueued.intentId).toBe(intents.only.id);
    expect(enqueued.providerId).toBe('provider-a');
    expect(enqueued.request).toEqual(ARGS);
    expect(enqueued.response).toEqual({ answer: 'forty-two' });
    expect(enqueued.outputSchema).toBeDefined();
  });

  it('retries a failed enqueue once, and keeps the hold for the worker when the retry lands', async () => {
    let attempts = 0;
    const { calls, intents, ledger, settlement } = harness(
      { 'binding-provider-a': () => Promise.resolve(ok('forty-two')) },
      {
        settlementBehaviour: () =>
          ++attempts === 1 ? Promise.reject(new Error('blip')) : Promise.resolve(),
      },
    );

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('RESULT');
    expect(settlement.calls).toHaveLength(2);
    expect(intents.only.status).toBe(PaymentIntentStatus.VERIFYING);
    expect(ledger.kinds).toEqual(['HOLD_CREATE']);
  });

  /**
   * Final review N-3: an enqueue failure used to VOID the intent — no charge —
   * while the data still went back, and a buyer could provoke that failure at
   * will (a `\u0000` in an argument). A call that returned data is never made
   * free by a failure to record it: it settles as served, unverified.
   */
  it('still returns the result when the enqueue keeps failing, and settles the call as served', async () => {
    const { calls, intents, ledger } = harness(
      { 'binding-provider-a': () => Promise.resolve(ok('forty-two')) },
      { settlementBehaviour: () => Promise.reject(new Error('durable store unavailable')) },
    );

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('RESULT');
    if (outcome.kind !== 'RESULT') return;
    expect(outcome.output).toEqual({ answer: 'forty-two' });
    expect(outcome.receipt.status).toBe(PaymentIntentStatus.SETTLED);
    expect(intents.only.status).toBe(PaymentIntentStatus.SETTLED);
    expect(intents.only.statusReason).toBe(MCP_VERIFICATION_ENQUEUE_FAILED_REASON);
    expect(ledger.kinds).not.toContain('HOLD_RELEASE');
    expect(ledger.kinds).toContain('HOLD_COMMIT');
  });

  it('records the provider only once the router has produced one', async () => {
    const { calls, intents } = harness({ 'binding-provider-a': () => Promise.resolve(ok()) });

    await calls.call(SESSION, 'Search the web', ARGS);

    // The intent was created without a payee — there was none to name — and
    // ends naming the operator that actually served the call.
    expect(intents.only.providerId).toBe('provider-a');
  });

  /**
   * **The regression test for a rail-A intent reaching `VERIFYING` without a payee.**
   *
   * Before it, `resolveDataResult` wrote `providerId`, `bindingId`,
   * `classification` and `reason`, and no `providerAccount`. Every rail-A
   * intent therefore reached `VERIFYING` with a null payee; the verification
   * worker's `VERIFYING → SETTLED` edge is a `COMMIT`, `resolve()` threw
   * `PAYMENT_PROVIDER_NOT_ASSIGNED` after the status had already moved, and the
   * agent's money stayed `held` with the provider credited nothing — 4,879
   * times on devnet.
   *
   * The assertion is on the **transition context**, not on the row: what went
   * wrong was a field missing from one call's arguments, and asserting the
   * stored value alone would pass against an implementation that wrote it in a
   * second, unguarded `UPDATE`.
   */
  it('writes providerAccount in the same transition that writes provider_id', async () => {
    const { calls, intents } = harness({ 'binding-provider-a': () => Promise.resolve(ok()) });

    await calls.call(SESSION, 'Search the web', ARGS);

    const naming = intents.contexts.filter((entry) => entry.context.providerId !== undefined);
    expect(naming).toHaveLength(1);
    expect(naming[0].to).toBe(PaymentIntentStatus.VERIFYING);
    // Who, where, and which implementation — one observation, one write.
    expect(naming[0].context.providerAccount).toBe(PAYOUT_ACCOUNT);
    expect(naming[0].context.bindingId).toBe('binding-provider-a');

    // And it landed on the row the settlement worker will read.
    expect(intents.only.providerAccount).toBe(PAYOUT_ACCOUNT);
  });

  it('names the payout account of the provider that SERVED, not the one first drawn', async () => {
    const served: AccountId =
      `${CHAIN_IDS.SOLANA_DEVNET}:C4bMn1VFzQgDCtdNcEw8ko9hSeDTLw3ZVJTyHxgjNwhY` as AccountId;

    const { calls, intents } = buildMcpHarness({
      bindings: [buildBinding('provider-a'), buildBinding('provider-b')],
      providers: [
        buildProvider('provider-a'),
        buildProvider('provider-b', { payoutAccountByChain: new Map([[PAYOUT_CHAIN, served]]) }),
      ],
      invoker: new ScriptedInvoker({
        // Drawn first (`random: () => 0`), fails retryably, and must not be paid.
        'binding-provider-a': () => Promise.resolve(status(503, { error: 'unavailable' })),
        'binding-provider-b': () => Promise.resolve(ok('served by b')),
      }),
      random: () => 0,
    });

    await calls.call(SESSION, 'Search the web', ARGS);

    // Same reason `binding_id` is written from the attempt that answered:
    // failover abandons the first draw, and paying it would credit a provider
    // for a call it did not serve.
    expect(intents.only.providerId).toBe('provider-b');
    expect(intents.only.providerAccount).toBe(served);
  });

  it('names the payout account for the chain the call SETTLES on, not the first enrolled', async () => {
    // `provider-a` is enrolled on mainnet FIRST and on the binding's own chain
    // second, so "the map's first entry" and "the entry for the settling
    // chain" are different addresses. The binding is priced in devnet USDC —
    // `buildBinding`'s default — so the intent must name the devnet one.
    //
    // A router that took the first entry writes a Solana-mainnet address onto
    // an intent that settles on devnet. It is a well-formed CAIP-10, it passes
    // every CHECK on `payment_intents`, and the money simply never arrives.
    const mainnetAccount =
      `${CHAIN_IDS.SOLANA_MAINNET}:HnT3pdiw7DagqUY6pST8YBVxfBxMncbQZaDmW8itofu7` as AccountId;
    const devnetAccount =
      `${CHAIN_IDS.SOLANA_DEVNET}:C4bMn1VFzQgDCtdNcEw8ko9hSeDTLw3ZVJTyHxgjNwhY` as AccountId;

    const { calls, intents } = buildMcpHarness({
      bindings: [buildBinding('provider-a')],
      providers: [
        buildProvider('provider-a', {
          payoutAccountByChain: new Map([
            [CHAIN_IDS.SOLANA_MAINNET, mainnetAccount],
            [PAYOUT_CHAIN, devnetAccount],
          ]),
        }),
      ],
      invoker: new ScriptedInvoker({ 'binding-provider-a': () => Promise.resolve(ok()) }),
    });

    await calls.call(SESSION, 'Search the web', ARGS);

    expect(intents.only.providerAccount).toBe(devnetAccount);
  });

  /**
   * The hole `evaluatePayoutGate` used to leave, now closed by the router.
   *
   * A tool with both a FREE and a PAID binding quotes as paid, so the call takes
   * the paid path and creates an intent. The router used to be free to draw the
   * FREE binding, which the payout and stake gates exempt — observed on devnet:
   * an agent charged $0.088 for a call a $0 binding served, by a provider nobody
   * had bonded or checked. A paid call is now routed with `callClass: 'PAID'`,
   * which leaves FREE bindings out of the pool.
   */
  function freeBindingBesideAPaidOne() {
    return buildMcpHarness({
      bindings: [
        // Drawn first under `random: () => 0` if it were in the pool. Free, so
        // the payout gate exempts it; its provider has proved nothing.
        buildBinding('provider-a', { pricingMode: PricingMode.FREE, priceAmount: '0' }),
        // What makes the tool quote as PAID, and what the agent is held for.
        buildBinding('provider-b'),
      ],
      providers: [
        buildProvider('provider-a', { payoutAccountByChain: new Map() }),
        buildProvider('provider-b'),
      ],
      invoker: new ScriptedInvoker({
        'binding-provider-a': () => Promise.resolve(ok('served free')),
        'binding-provider-b': () => Promise.resolve(ok('served paid')),
      }),
      random: () => 0,
    });
  }

  it('never routes a paid call to a FREE binding, so the paid provider serves it', async () => {
    const { calls, intents, bindingCalls } = freeBindingBesideAPaidOne();

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('RESULT');
    if (outcome.kind !== 'RESULT') return;
    expect(outcome.output).toEqual({ answer: 'served paid' });
    expect(intents.only.providerId).toBe('provider-b');
    expect(intents.only.status).toBe(PaymentIntentStatus.VERIFYING);
    expect(bindingCalls.recorded).toEqual(['binding-provider-b']);
  });

  it('refuses to route a PAID binding whose provider has proved no payout address', async () => {
    const { calls } = harness(
      { 'binding-provider-a': () => Promise.resolve(ok()) },
      { providers: [buildProvider('provider-a', { payoutAccountByChain: new Map() })] },
    );

    // The routing exclusion, from the MCP path's point of view: the call is
    // refused before an intent exists, so no hold is opened and nothing has to
    // be unwound. `TOOL_NO_ELIGIBLE_BINDING` and not a payment error — from the
    // agent's side there is simply no supply it can buy.
    await expectErrorCodeAsync(
      () => calls.call(SESSION, 'Search the web', ARGS),
      'TOOL_NO_ELIGIBLE_BINDING',
    );
  });

  /**
   * The row that proves which binding served the call.
   *
   * `provider_id` and `binding_id` answer two different questions — *who is
   * paid* and *which of their published implementations ran* — and they are
   * written by one transition because they are one observation. Splitting them
   * into two writes would put a window between them in which the intent names
   * a provider and no binding, and the exploration count is defined off the
   * second half.
   */
  it('writes binding_id in the same transition that writes provider_id', async () => {
    const { calls, intents, bindingCalls } = harness({
      'binding-provider-a': () => Promise.resolve(ok()),
    });

    await calls.call(SESSION, 'Search the web', ARGS);

    expect(intents.only.bindingId).toBe('binding-provider-a');

    // One transition carries the identification, and it carries both halves.
    const naming = intents.contexts.filter((entry) => entry.context.providerId !== undefined);
    expect(naming).toHaveLength(1);
    expect(naming[0].to).toBe(PaymentIntentStatus.VERIFYING);
    expect(naming[0].context.bindingId).toBe('binding-provider-a');

    // And the counter is incremented from that same point — once.
    expect(bindingCalls.recorded).toEqual(['binding-provider-a']);
  });

  /**
   * The case that decides whether the count is a fact or a guess.
   *
   * The intent exists **before** the router picks, and on failover the binding
   * that finally answered is not the one first drawn. A `binding_id` written
   * from the selection would name a binding that was abandoned mid-call, and
   * the exploration floor would then hand traffic to bindings on the strength
   * of calls they never served.
   */
  it('writes the binding that SERVED, not the one first selected', async () => {
    const { calls, intents, bindingCalls } = buildMcpHarness({
      bindings: [buildBinding('provider-a'), buildBinding('provider-b')],
      providers: [buildProvider('provider-a'), buildProvider('provider-b')],
      invoker: new ScriptedInvoker({
        // Drawn first (`random: () => 0`), and fails retryably.
        'binding-provider-a': () => Promise.resolve(status(503, { error: 'unavailable' })),
        'binding-provider-b': () => Promise.resolve(ok('served by b')),
      }),
      random: () => 0,
    });

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('RESULT');
    expect(intents.only.providerId).toBe('provider-b');
    expect(intents.only.bindingId).toBe('binding-provider-b');

    // The abandoned binding is counted **nowhere**. Counting it would make
    // `binding-provider-a` look older than it is and lose it exploration
    // traffic it has not yet spent.
    expect(bindingCalls.recorded).toEqual(['binding-provider-b']);
  });

  /**
   * A `REQUEST_ERROR` is a served call: the provider answered, the answer was
   * theirs, and the agent pays nothing. The binding still ran, so the row still
   * records it and the count still moves — the exploration floor is measuring
   * how much has been *observed* of a binding, not how much it earned.
   */
  it('records the binding on the void path too, where the provider answered', async () => {
    const { calls, intents, bindingCalls } = harness({
      'binding-provider-a': () => Promise.resolve(status(400, { error: 'bad query' })),
    });

    await calls.call(SESSION, 'Search the web', ARGS);

    expect(intents.only.status).toBe(PaymentIntentStatus.VOIDED);
    expect(intents.only.bindingId).toBe('binding-provider-a');
    expect(bindingCalls.recorded).toEqual(['binding-provider-a']);
  });

  /**
   * Failover exhausted every provider: the router threw, and the intent is
   * voided. E2E (EVM run, E2): it used to be voided as "the call never reached
   * one", with no classification and no binding, although every binding was
   * dialled and answered SYSTEM_ERROR — and the agent's error carried no intent
   * id to open the receipt with.
   *
   * The row now records what happened: SYSTEM_ERROR, and the last binding and
   * provider tried. The counter follows the row, as on every other void path,
   * so the one binding the row names is counted and the others are not.
   */
  it('voids as SYSTEM_ERROR naming the last binding tried, and hands the agent the intent id', async () => {
    const invoker = new ScriptedInvoker({
      'binding-provider-a': () => Promise.resolve(status(500)),
      'binding-provider-b': () => Promise.resolve(status(500)),
    });
    const { calls, intents, bindingCalls, ledger } = buildMcpHarness({
      bindings: [buildBinding('provider-a'), buildBinding('provider-b')],
      providers: [buildProvider('provider-a'), buildProvider('provider-b')],
      invoker,
      random: () => 0,
    });

    const error = await calls
      .call(SESSION, 'Search the web', ARGS)
      .then(() => null)
      .catch((e: AppError) => e);

    expect(error?.errorCode).toBe('TOOL_ALL_BINDINGS_FAILED');
    expect(invoker.bindingIds).toHaveLength(2);
    const last = invoker.invocations[invoker.invocations.length - 1].binding;

    const intent = intents.only;
    expect(intent.status).toBe(PaymentIntentStatus.VOIDED);
    expect(intent.classification).toBe(ResponseClass.SYSTEM_ERROR);
    expect(intent.bindingId).toBe(last.id);
    expect(intent.providerId).toBe(last.providerId);
    expect(intent.statusReason).not.toBe(MCP_UNROUTABLE_REASON);
    expect(ledger.kinds).toEqual(['HOLD_CREATE', 'HOLD_RELEASE']);
    expect(bindingCalls.recorded).toEqual([last.id]);

    // The agent can open the receipt; the binding stays the platform's.
    expect(error?.context).toMatchObject({ intentId: intent.id });
    expect(error?.context).not.toHaveProperty('lastAttempt');
    expect(JSON.stringify(error?.context)).not.toContain(last.id);
  });

  it('charges the quoted price and splits the platform fee out of it', async () => {
    const { calls, intents } = harness(
      { 'binding-provider-a': () => Promise.resolve(ok()) },
      { platformFeeBps: 2000 },
    );

    await calls.call(SESSION, 'Search the web', ARGS);

    const intent = intents.only;
    expect(intent.price.amount).toBe(usdc('0.05').amount);
    expect(intent.platformFee.amount).toBe(usdc('0.01').amount);
    expect(intent.providerAmount.amount).toBe(usdc('0.04').amount);
    expect(intent.rail).toBe(PaymentRail.RAIL_A_PER_CALL);
  });

  it('keeps 10% by default, the take rate the provider terms state', async () => {
    const { calls, intents } = harness({ 'binding-provider-a': () => Promise.resolve(ok()) });

    await calls.call(SESSION, 'Search the web', ARGS);

    expect(intents.only.platformFee.amount).toBe(usdc('0.005').amount);
    expect(intents.only.providerAmount.amount).toBe(usdc('0.045').amount);
  });

  // ── Outcomes that earn no charge ──────────────────────────────────────────

  /**
   * A `SYSTEM_ERROR` never comes back as an outcome — the router either fails
   * over or exhausts its providers and throws. With one provider there is
   * nowhere to fail over to, so the agent sees `TOOL_ALL_BINDINGS_FAILED` and
   * the intent is voided on the way out.
   */
  it('voids and releases the hold when the only provider fails', async () => {
    const { calls, ledger, intents } = harness({
      'binding-provider-a': () => Promise.resolve(status(500, { error: 'down' })),
    });

    await expectErrorCodeAsync(
      () => calls.call(SESSION, 'Search the web', ARGS),
      'TOOL_ALL_BINDINGS_FAILED',
    );

    expect(ledger.kinds).toEqual(['HOLD_CREATE', 'HOLD_RELEASE']);
    expect(intents.only.status).toBe(PaymentIntentStatus.VOIDED);
  });

  it('voids on a REQUEST_ERROR and tells the agent not to retry', async () => {
    const { calls, ledger } = harness({
      'binding-provider-a': () => Promise.resolve(status(400, { error: 'bad query' })),
    });

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('ERROR');
    if (outcome.kind !== 'ERROR') return;

    expect(outcome.code).toBe(McpFailureCode.PROVIDER_REQUEST_ERROR);
    expect(outcome.retryable).toBe(false);
    expect(ledger.kinds).toEqual(['HOLD_CREATE', 'HOLD_RELEASE']);
    // BUG-R3-J-03: the bare "was not served: REQUEST_REJECTED" gave no direction.
    expect(outcome.message).toMatch(
      /the provider rejected the request \(REQUEST_REJECTED, status 400\)/,
    );
    expect(outcome.message).toMatch(/Nothing was charged/);
    expect(outcome.message).toMatch(/do not retry it unchanged/);
    expect(outcome.detail.fault).toBe('UNDETERMINED');
  });

  /**
   * A `DATA_RESULT` whose payload did not fit the tool's contract.
   *
   * The response mapping is what ran the schema check, and it failed — so the
   * stopgap refunds rather than settles. It is the only verdict this milestone
   * is entitled to reach, and it is the one the full engine would reach too.
   */
  it('refunds a response that did not honour the tool contract', async () => {
    const { calls, ledger, intents } = harness({
      // A 2xx with JSON whose `answer` the mapping *finds* — so the fault is
      // the provider's, not ours — and whose value is a number where the tool's
      // outputSchema requires a string.
      'binding-provider-a': () => Promise.resolve(jsonResponse({ answer: 42 })),
    });

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('ERROR');
    if (outcome.kind !== 'ERROR') return;

    expect(outcome.code).toBe(McpFailureCode.PROVIDER_CONTRACT_VIOLATION);
    expect(outcome.message).toMatch(/provider's fault, not your arguments; a retry will not help/);
    expect(outcome.detail.fault).toBe('PROVIDER');
    expect(ledger.kinds).toEqual(['HOLD_CREATE', 'HOLD_RELEASE']);
    expect(intents.only.status).toBe(PaymentIntentStatus.REFUNDED);
  });

  /**
   * Refused at the quote, before an intent exists.
   *
   * `tools/list` would not have advertised this tool at all — the same gate
   * runs in both places — so this is the case where an agent calls a tool it
   * learned about a moment before every provider behind it went away.
   */
  it('refuses a tool with no routable supply without creating an intent', async () => {
    const { calls, ledger, intents } = harness(
      {
        'binding-provider-a': () => {
          throw new Error('the provider must never be called');
        },
      },
      { providers: [buildProvider('provider-a', { status: ProviderStatus.SUSPENDED })] },
    );

    await expectErrorCodeAsync(
      () => calls.call(SESSION, 'Search the web', ARGS),
      'TOOL_NO_ELIGIBLE_BINDING',
    );

    expect(ledger.kinds).toEqual([]);
    expect(intents.rows.size).toBe(0);
  });

  it('refuses a buyer whose chain no routable binding settles on, before any intent or hold', async () => {
    // The quote is priced across every enabled chain; the buyer pays from one.
    // Securing funds against a price on another chain would answer
    // PAYMENT_INSUFFICIENT_FUNDS for a call that was never payable from here.
    const { calls, ledger, intents } = harness({
      'binding-provider-a': () => {
        throw new Error('the provider must never be called');
      },
    });
    const elsewhere = {
      ...SESSION,
      chainId: CHAIN_IDS.SOLANA_MAINNET,
      agentAccount: `${CHAIN_IDS.SOLANA_MAINNET}:AgentOnAnotherChain11111111111111111` as AccountId,
    };

    await expectErrorCodeAsync(
      () => calls.call(elsewhere, 'Search the web', ARGS),
      'PAYMENT_NO_SETTLEABLE_CHAIN',
    );

    expect(ledger.kinds).toEqual([]);
    expect(intents.rows.size).toBe(0);
  });

  // ── Refused before any money moves ────────────────────────────────────────

  it('refuses an unknown tool without creating an intent', async () => {
    const { calls, ledger, intents } = harness({});

    await expectErrorCodeAsync(
      () => calls.call(SESSION, 'no_such_tool', ARGS),
      'MCP_TOOL_NOT_FOUND',
    );

    expect(ledger.kinds).toEqual([]);
    expect(intents.rows.size).toBe(0);
  });

  it('refuses a missing required argument without creating an intent', async () => {
    const { calls, ledger, intents } = harness({
      'binding-provider-a': () => {
        throw new Error('the provider must never be called');
      },
    });

    await expectErrorCodeAsync(
      () => calls.call(SESSION, 'Search the web', {}),
      'TOOL_MAPPING_REQUIRED_FIELD_MISSING',
    );

    expect(ledger.kinds).toEqual([]);
    expect(intents.rows.size).toBe(0);
  });

  /**
   * The intent *is* created — the platform tried to charge and could not, and
   * that attempt is a record — but no hold is opened and no provider is
   * called. The `CREATED → EXPIRED` edge carries `HoldEffect.NONE`, so the
   * five-minute sweep closes the row with nothing to give back.
   */
  it('stops at the balance check, leaving the intent in CREATED', async () => {
    const { calls, ledger, intents } = harness(
      {
        'binding-provider-a': () => {
          throw new Error('the provider must never be called');
        },
      },
      { balance: usdc('0.01') },
    );

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('ERROR');
    if (outcome.kind !== 'ERROR') return;

    expect(outcome.code).toBe(McpFailureCode.PAYMENT_INSUFFICIENT_FUNDS);
    expect(outcome.retryable).toBe(false);
    expect(outcome.detail.available).toBe(usdc('0.01').amount);

    expect(ledger.kinds).toEqual([]);
    expect(intents.only.status).toBe(PaymentIntentStatus.CREATED);
    expect(intents.only.holdId).toBeNull();
  });

  // ── Failover, with one hold ───────────────────────────────────────────────

  it('fails over to a second provider under a single hold', async () => {
    const { calls, ledger, intents, settlement } = buildMcpHarness({
      bindings: [buildBinding('provider-a'), buildBinding('provider-b')],
      providers: [buildProvider('provider-a'), buildProvider('provider-b')],
      invoker: new ScriptedInvoker({
        'binding-provider-a': () => Promise.resolve(status(503, { error: 'unavailable' })),
        'binding-provider-b': () => Promise.resolve(ok('served by b')),
      }),
      random: () => 0,
    });

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('RESULT');
    if (outcome.kind !== 'RESULT') return;

    expect(outcome.output).toEqual({ answer: 'served by b' });
    expect(outcome.receipt.attempts).toBe(2);
    // One hold for the whole call, whichever provider ends up serving it —
    // and it stays open: its resolution belongs to the verification worker.
    expect(ledger.kinds).toEqual(['HOLD_CREATE']);
    expect(intents.only.providerId).toBe('provider-b');
    expect(settlement.calls).toHaveLength(1);
    expect(settlement.calls[0].providerId).toBe('provider-b');
  });

  it('voids once when every provider fails', async () => {
    const { calls, ledger } = buildMcpHarness({
      bindings: [buildBinding('provider-a'), buildBinding('provider-b')],
      providers: [buildProvider('provider-a'), buildProvider('provider-b')],
      invoker: new ScriptedInvoker({
        'binding-provider-a': () => Promise.resolve(status(500)),
        'binding-provider-b': () => Promise.resolve(status(500)),
      }),
    });

    await expectErrorCodeAsync(
      () => calls.call(SESSION, 'Search the web', ARGS),
      'TOOL_ALL_BINDINGS_FAILED',
    );

    expect(ledger.kinds).toEqual(['HOLD_CREATE', 'HOLD_RELEASE']);
  });

  it('releases the hold when the provider never answers', async () => {
    const { calls, ledger } = buildMcpHarness({
      bindings: [buildBinding('provider-a', { timeoutMs: 40 })],
      providers: [buildProvider('provider-a')],
      invoker: new ScriptedInvoker({ 'binding-provider-a': hang }),
    });

    await expectErrorCodeAsync(
      () => calls.call(SESSION, 'Search the web', ARGS),
      'TOOL_ALL_BINDINGS_FAILED',
    );

    expect(ledger.kinds).toEqual(['HOLD_CREATE', 'HOLD_RELEASE']);
  });

  /**
   * REGRESSION (review 2026-10-15 P-6): the caps were read, and the hold
   * written, as separate steps — so N concurrent calls all read the same
   * spend-so-far and all fit. The check and the hold now run under the agent's
   * spend lock: the second call's check sees the first call's hold.
   */
  it('lets concurrent calls of one agent overshoot no cap', async () => {
    const h = harness({
      'binding-provider-a': () => Promise.resolve(ok()),
      'binding-provider-a#2': () => Promise.resolve(ok()),
    });
    h.spendPolicy.holdCap = {
      max: 1,
      held: () => h.ledger.kinds.filter((kind) => kind === 'HOLD_CREATE').length,
    };

    const results = await Promise.allSettled([
      h.calls.call(SESSION, 'Search the web', ARGS),
      h.calls.call(SESSION, 'Search the web', { query: 'another' }),
    ]);

    expect(h.ledger.kinds.filter((kind) => kind === 'HOLD_CREATE')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(h.spendPolicy.uncheckedOutsideLock).toBe(0);
  });
});
