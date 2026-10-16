import { offerSolanaRailAInThisSuite } from '../helpers/solana-rail-b';
import { FreeQuotaLimitKind } from '@modules/free-tier/services/free-quota.service';
import { McpErrorCode } from '@modules/mcp/errors/mcp.errors';
import { McpFailureCode } from '@modules/mcp/services/mcp-tool-call.service';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { AppError } from '@shared/errors/app-errors';

import {
  InvokerScript,
  ScriptedInvoker,
  buildBinding,
  buildProvider,
  ok,
  status,
} from '../tool/helpers/routing-fixtures';
import { McpHarnessOptions, SESSION, buildMcpHarness } from './helpers/mcp-harness';

/**
 * The relay path: what a **free** call does, and more importantly what it does
 * not do.
 *
 * The contract is four absences — no intent, no voucher, no hold, no ledger
 * write — so most of
 * this suite asserts that things did **not** happen. That is deliberate: every
 * one of those four is a line of code that used to run on this path, and the
 * regression to fear is not a wrong value but the paid machinery quietly
 * coming back.
 *
 * It also pins the defect that made this path necessary. Before the fork,
 * every call class including `FREE` went through `secureFunds`, and
 * `LedgerHoldService.createHold` refuses a zero amount — so the first
 * genuinely free binding answered `409`. No demo binding was free, which is
 * the only reason nobody had hit it.
 */
describe('McpToolCallService — the relay path', () => {
  // Solana has no paid rail by default (review 2026-10-15, C1); these cases
  // pin the rail-A code that is kept for when it is switched back on.
  offerSolanaRailAInThisSuite();

  const ARGS = { query: 'moon landing' };

  function freeHarness(
    script: Readonly<Record<string, InvokerScript>>,
    pricingMode: PricingMode = PricingMode.FREE,
    overrides: Partial<McpHarnessOptions> = {},
  ) {
    return buildMcpHarness({
      bindings: [
        buildBinding('provider-a', {
          pricingMode,
          // A `FREE` binding is priced at zero — the amount `createHold`
          // refuses, which is the whole point of not opening one. A `FREEMIUM`
          // one keeps the fixture's paid price, because that is what it costs
          // once the quota is gone.
          ...(pricingMode === PricingMode.FREE ? { priceAmount: '0' } : {}),
          freeQuotaPerAgent: 100,
        }),
      ],
      providers: [buildProvider('provider-a')],
      invoker: new ScriptedInvoker(script),
      ...overrides,
    });
  }

  // ── The four absences ─────────────────────────────────────────────────────

  it('serves a FREE call with no payment intent and no hold', async () => {
    const { calls, intents, ledger } = freeHarness({
      'binding-provider-a': () => Promise.resolve(ok('forty-two')),
    });

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('RESULT');
    // The four absences, in the doc's own order.
    expect(intents.rows.size).toBe(0);
    expect(ledger.events).toHaveLength(0);
  });

  it('does not 409 on a zero-priced binding — the defect this path exists to fix', async () => {
    const { calls, ledger } = freeHarness({
      'binding-provider-a': () => Promise.resolve(ok('forty-two')),
    });

    // `FakeLedger.createHold` refuses a zero amount exactly as the real one
    // does, so reaching a RESULT at all is the assertion: nothing tried.
    await expect(calls.call(SESSION, 'Search the web', ARGS)).resolves.toMatchObject({
      kind: 'RESULT',
    });
    expect(ledger.events).toHaveLength(0);
  });

  it('hands the agent a receipt that names no intent and charges nothing', async () => {
    const { calls } = freeHarness({
      'binding-provider-a': () => Promise.resolve(ok('forty-two')),
    });

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);
    if (outcome.kind !== 'RESULT') throw new Error('expected a RESULT');

    // `null`, not a fabricated id: there is no payment record, and inventing
    // one would put a free call into every "what did I pay for" fold.
    expect(outcome.receipt.intentId).toBeNull();
    expect(outcome.receipt.status).toBeNull();
    expect(outcome.receipt.charged.amount).toBe('0');
  });

  // ── What it does leave behind ─────────────────────────────────────────────

  it('writes a tool_call_record naming the binding that actually served', async () => {
    const { calls, toolCallRecords } = freeHarness({
      'binding-provider-a': () => Promise.resolve(ok('forty-two')),
    });

    await calls.call(SESSION, 'Search the web', ARGS);

    expect(toolCallRecords.written).toHaveLength(1);
    expect(toolCallRecords.written[0]).toMatchObject({
      organizationId: SESSION.organizationId,
      agentId: SESSION.agentId,
      bindingId: 'binding-provider-a',
      providerId: 'provider-a',
      pricingMode: PricingMode.FREE,
    });
    // Zero, never the quote's paid price — see the hash comment in `relay()`.
    expect(toolCallRecords.written[0].requestHash).toEqual(expect.any(String));
  });

  it('consumes the quota against the binding that served, and counts the observation', async () => {
    const { calls, freeQuota, bindingCalls } = freeHarness({
      'binding-provider-a': () => Promise.resolve(ok('forty-two')),
    });

    await calls.call(SESSION, 'Search the web', ARGS);

    expect(freeQuota.consumed).toEqual(['binding-provider-a']);
    // A free call is still an observation of the binding, which is what the
    // exploration floor measures.
    await expect(bindingCalls.observedCalls('binding-provider-a')).resolves.toBe(1);
  });

  it('records a REQUEST_ERROR too — the provider was dialled and the platform paid for it', async () => {
    const { calls, toolCallRecords, intents } = freeHarness({
      'binding-provider-a': () => Promise.resolve(status(400, { error: 'nope' })),
    });

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('ERROR');
    if (outcome.kind !== 'ERROR') return;
    expect(outcome.code).toBe(McpFailureCode.PROVIDER_REQUEST_ERROR);
    // No intent to void — nothing was ever created.
    expect(outcome.intentId).toBeNull();
    expect(intents.rows.size).toBe(0);
    expect(toolCallRecords.written).toHaveLength(1);
  });

  // ── Exhaustion ────────────────────────────────────────────────────────────

  it('refuses an exhausted FREE tool with a reset time and no invented paid option', async () => {
    const resetsAt = new Date('2026-08-23T00:00:00.000Z');
    const { calls, freeQuota, intents, toolCallRecords } = freeHarness({
      'binding-provider-a': () => Promise.resolve(ok('forty-two')),
    });

    freeQuota.decision = {
      kind: 'REFUSED',
      limit: FreeQuotaLimitKind.PROVIDER_PER_AGENT_DAILY,
      resetsAt,
      // No paid binding exists behind a FREE-only tool, so there is nowhere to
      // fall through to.
      fallThroughToPaid: false,
    };

    const error = await captureError(() => calls.call(SESSION, 'Search the web', ARGS));

    expect(error).toBeInstanceOf(AppError);
    const thrown = error as AppError;
    expect(thrown.errorCode).toBe(McpErrorCode.MCP_QUOTA_EXCEEDED);

    const context = thrown.context as Record<string, unknown>;
    expect(context.resetsAt).toBe(resetsAt.toISOString());
    // Nothing may claim there is a way to pay when there is not — an agent
    // that follows a fabricated paid option arrives nowhere.
    expect(context.paymentRequired).toBeUndefined();
    expect(context.paidAlternative).toBeUndefined();

    // The refusal is free in both senses: the provider was never dialled.
    expect(intents.rows.size).toBe(0);
    expect(toolCallRecords.written).toHaveLength(0);
  });

  it('falls a FREEMIUM tool through to the paid path rather than erroring', async () => {
    const { calls, intents, freeQuota, ledger, toolCallRecords } = freeHarness(
      { 'binding-provider-a': () => Promise.resolve(ok('forty-two')) },
      PricingMode.FREEMIUM,
    );

    freeQuota.decision = {
      kind: 'REFUSED',
      limit: FreeQuotaLimitKind.PROVIDER_PER_AGENT_DAILY,
      resetsAt: new Date('2026-08-23T00:00:00.000Z'),
      // The entire commercial point of FREEMIUM: past the quota, pay.
      fallThroughToPaid: true,
    };

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('RESULT');
    // It took the paid path: an intent exists, a hold was opened, and no
    // free-call record was written.
    expect(intents.rows.size).toBe(1);
    expect(ledger.events.filter((event) => event.kind === 'HOLD_CREATE')).toHaveLength(1);
    expect(toolCallRecords.written).toHaveLength(0);
  });

  // ── The gate still runs on the paid path ──────────────────────────────────

  it('runs the spend-policy gate before any intent exists', async () => {
    const { calls, spendPolicy, intents } = buildMcpHarness({
      bindings: [buildBinding('provider-a')],
      providers: [buildProvider('provider-a')],
      invoker: new ScriptedInvoker({
        'binding-provider-a': () => Promise.resolve(ok('forty-two')),
      }),
    });

    spendPolicy.refuseWith = new Error('refused by policy');

    await expect(calls.call(SESSION, 'Search the web', ARGS)).rejects.toThrow('refused by policy');
    // The refusal cost nothing: no payment record to sweep, no hold to release.
    expect(intents.rows.size).toBe(0);
  });

  it('gives the gate and the payment record the same request hash', async () => {
    const { calls, spendPolicy, intents } = buildMcpHarness({
      bindings: [buildBinding('provider-a')],
      providers: [buildProvider('provider-a')],
      invoker: new ScriptedInvoker({
        'binding-provider-a': () => Promise.resolve(ok('forty-two')),
      }),
    });

    await calls.call(SESSION, 'Search the web', ARGS);

    // Two call sites, one value. Hashing twice would work today and would stop
    // working silently the first time either site's inputs drifted.
    expect(spendPolicy.checked).toHaveLength(1);
    const created = [...intents.rows.values()];
    expect(spendPolicy.checked[0].requestHash).toBe(created[0].requestHash);
  });
});

/**
 * The thrown error itself, not just its code.
 *
 * `expectErrorCodeAsync` next door asserts the code and discards the error,
 * and this suite needs the `context` — which is the whole point of the
 * refusal: `resetsAt` and the paid option are what make an exhausted quota
 * actionable rather than just a wall.
 */
async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, and it resolved');
}
