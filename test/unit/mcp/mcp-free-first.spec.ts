import { AccountId } from '@modules/chains/ports/caip.types';
import { FreeQuotaLimitKind } from '@modules/free-tier/services/free-quota.service';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { McpFailureCode, VoucherRequirement } from '@modules/mcp/services/mcp-tool-call.service';
import { PaymentRail } from '@modules/payment/ports/payment.types';
import { ToolErrorCode, ToolErrors } from '@modules/tool/errors/tool.errors';
import { RoutingContext } from '@modules/tool/domain/routing/routing.types';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { AppError } from '@shared/errors/app-errors';

import {
  InvokerScript,
  PAYOUT_ACCOUNT,
  ScriptedInvoker,
  buildBinding,
  buildProvider,
  ok,
  status,
  usdc,
} from '../tool/helpers/routing-fixtures';
import { CHAIN_ID, SESSION, buildMcpHarness } from './helpers/mcp-harness';
import { offerSolanaRailsInThisSuite } from '../helpers/solana-rail-b';

/**
 * Free first, then paid — one tool with free-capable AND paid supply.
 *
 * Provider A serves the tool `FREE` (and holds no stake: the `FREE` exemption
 * is the only thing admitting it), provider B serves it `PAID`. The tool is
 * quoted `FREEMIUM`, so a call:
 *
 * 1. is served free by A while the agent's free quota lasts — routed with
 *    `callClass: 'FREE'`, so it can never reach B, who would be paid nothing;
 * 2. falls through to the normal paid path once the quota is gone, or when no
 *    free-capable binding can take it — routed with `callClass: 'PAID'`, so it
 *    can never reach A, which no stake or payout gate checked.
 *
 * On rail B the fall-through is `x402/paymentRequired`: nothing is charged
 * without a voucher the buyer signs.
 */
describe('McpToolCallService — free first, then paid', () => {
  // The paid cases run on the Solana harness session; Solana has no paid rail
  // by default (no-platform-debt step 3, review 2026-10-15 C1), so this suite
  // re-opens both.
  offerSolanaRailsInThisSuite('A', 'B');

  const ARGS = { query: 'moon landing' };
  const TOOL_NAME = 'Search the web';
  const FREE_PROVIDER = 'provider-a';
  const PAID_PROVIDER = 'provider-b';
  const RAIL_B_SESSION: McpSession = {
    ...SESSION,
    agentAccount: `${CHAIN_ID}:Agent1111111111111111111111111111111111111` as AccountId,
  };

  function harness(freeAnswer: InvokerScript = async () => ok('free')) {
    const invoker = new ScriptedInvoker({
      [`binding-${FREE_PROVIDER}`]: freeAnswer,
      [`binding-${PAID_PROVIDER}`]: async () => ok('paid'),
    });
    const built = buildMcpHarness({
      bindings: [
        buildBinding(FREE_PROVIDER, {
          pricingMode: PricingMode.FREE,
          priceAmount: '0',
          freeQuotaPerAgent: 100,
        }),
        buildBinding(PAID_PROVIDER, { priceAmount: usdc('0.05').amount }),
      ],
      providers: [buildProvider(FREE_PROVIDER), buildProvider(PAID_PROVIDER)],
      // Only the paid provider is staked.
      stakes: { [PAID_PROVIDER]: usdc(1000) },
      invoker,
    });
    return { ...built, invoker };
  }

  function exhaust(h: ReturnType<typeof harness>): void {
    h.freeQuota.decision = {
      kind: 'REFUSED',
      limit: FreeQuotaLimitKind.PROVIDER_PER_AGENT_DAILY,
      resetsAt: new Date('2026-10-17T00:00:00.000Z'),
      // What the real service answers for a FREEMIUM quote.
      fallThroughToPaid: true,
    };
  }

  it('serves the call free from the free-capable binding while the quota lasts', async () => {
    const h = harness();

    for (let index = 0; index < 20; index += 1) {
      const outcome = await h.calls.call(SESSION, TOOL_NAME, ARGS);
      if (outcome.kind !== 'RESULT') throw new Error('expected a RESULT');
      // Never the PAID provider: it would serve a call nobody pays for.
      expect(outcome.receipt.providerId).toBe(FREE_PROVIDER);
      expect(outcome.receipt.charged.amount).toBe('0');
    }

    expect(h.intents.rows.size).toBe(0);
    expect(h.ledger.events).toHaveLength(0);
    // Asked as FREEMIUM, so an exhausted quota falls through rather than refuses.
    expect(h.freeQuota.checked[0]).toMatchObject({ pricingMode: PricingMode.FREEMIUM });
    expect(h.freeQuota.consumed).toEqual(Array(20).fill(`binding-${FREE_PROVIDER}`));
  });

  it('falls through to the paid binding on rail A once the quota is exhausted', async () => {
    const h = harness();
    exhaust(h);

    const outcome = await h.calls.call(SESSION, TOOL_NAME, ARGS);

    if (outcome.kind !== 'RESULT') throw new Error('expected a RESULT');
    expect(outcome.receipt.providerId).toBe(PAID_PROVIDER);
    // Held at the paid supply's price — the FREE binding's zero is not part of it.
    expect(outcome.receipt.held).toEqual(usdc('0.05'));
    expect(h.intents.only.providerId).toBe(PAID_PROVIDER);
    expect(h.intents.only.price).toEqual(usdc('0.05'));
    expect(h.toolCallRecords.written).toHaveLength(0);
    // The FREE binding was never dialled for a charged call.
    expect(h.invoker.bindingIds).toEqual([`binding-${PAID_PROVIDER}`]);
  });

  it('asks for a voucher naming the paid provider on rail B once the quota is exhausted', async () => {
    const h = harness();
    exhaust(h);

    const outcome = await h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, {
      rail: PaymentRail.RAIL_B_VOUCHER,
      voucher: null,
    });

    expect(outcome).toMatchObject({ kind: 'ERROR', code: McpFailureCode.PAYMENT_REQUIRED });
    if (outcome.kind !== 'ERROR') return;
    const requirement = outcome.detail.paymentRequired as VoucherRequirement;
    expect(requirement.providerId).toBe(PAID_PROVIDER);
    expect(requirement.provider).toBe(PAYOUT_ACCOUNT);
    expect(requirement.amount).toEqual(usdc('0.05'));
    // Nothing charged, nothing held, nobody dialled — until the buyer signs.
    expect(h.intents.rows.size).toBe(0);
    expect(h.ledger.events).toHaveLength(0);
    expect(h.invoker.invocations).toHaveLength(0);
  });

  it('serves a rail-B session free while the quota lasts, with no voucher asked for', async () => {
    const h = harness();

    const outcome = await h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, {
      rail: PaymentRail.RAIL_B_VOUCHER,
      voucher: null,
    });

    if (outcome.kind !== 'RESULT') throw new Error('expected a RESULT');
    expect(outcome.receipt.providerId).toBe(FREE_PROVIDER);
    expect(outcome.receipt.charged.amount).toBe('0');
    expect(h.intents.rows.size).toBe(0);
  });

  it('still serves a free call while the payer has an open buyer debt', async () => {
    const h = harness();
    h.intents.debts = [
      {
        id: 'intent-debt-1',
        organizationId: RAIL_B_SESSION.organizationId,
        agentAccount: RAIL_B_SESSION.agentAccount,
        providerId: PAID_PROVIDER,
        providerAccount: null,
        toolId: 'tool-1',
        chainId: CHAIN_ID,
        assetId: 'x',
        decimals: 6,
        priceAmount: '1',
        requestHash: 'h',
        voucherResourceHash: null,
        voucherSeq: '1',
        lapsedAt: new Date(),
        cause: 'VoucherExpired',
        createdAt: new Date(),
      },
    ];

    const outcome = await h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, {
      rail: PaymentRail.RAIL_B_VOUCHER,
      voucher: null,
    });

    if (outcome.kind !== 'RESULT') throw new Error('expected a RESULT');
    expect(outcome.receipt.charged.amount).toBe('0');
  });

  it('falls through to the paid path when no free-capable binding can take the call', async () => {
    const h = harness();
    // The free binding drops out between the quote and the call — at its
    // ceiling, say. Routing refuses BEFORE dialling anybody.
    const route = h.router.route.bind(h.router);
    jest.spyOn(h.router, 'route').mockImplementation((request) => {
      const context: RoutingContext = request.context;
      if (context.callClass === 'FREE') {
        return Promise.reject(ToolErrors.noEligibleBinding({ toolId: request.toolId }));
      }
      return route(request);
    });

    const outcome = await h.calls.call(SESSION, TOOL_NAME, ARGS);

    if (outcome.kind !== 'RESULT') throw new Error('expected a RESULT');
    expect(outcome.receipt.providerId).toBe(PAID_PROVIDER);
    expect(h.intents.rows.size).toBe(1);
    // No free call happened, so no quota was spent.
    expect(h.freeQuota.consumed).toEqual([]);
  });

  it('does not charge for a retry after a free provider was dialled and failed', async () => {
    const h = harness(async () => status(503, { error: 'down' }));

    const error = await h.calls.call(SESSION, TOOL_NAME, ARGS).catch((thrown: unknown) => thrown);

    // The free call ran and failed over until free supply ran out. Turning
    // that into a paid call the agent never asked for would be a surprise
    // charge; the agent gets the outage and decides.
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).errorCode).toBe(ToolErrorCode.TOOL_ALL_BINDINGS_FAILED);
    expect(h.intents.rows.size).toBe(0);
    expect(new Set(h.invoker.bindingIds)).toEqual(new Set([`binding-${FREE_PROVIDER}`]));
  });

  it('still refuses a FREE-only tool past its quota — there is no paid supply to fall to', async () => {
    const h = buildMcpHarness({
      bindings: [buildBinding(FREE_PROVIDER, { pricingMode: PricingMode.FREE, priceAmount: '0' })],
      providers: [buildProvider(FREE_PROVIDER)],
      stakes: {},
      invoker: new ScriptedInvoker({ [`binding-${FREE_PROVIDER}`]: async () => ok() }),
    });
    h.freeQuota.decision = {
      kind: 'REFUSED',
      limit: FreeQuotaLimitKind.PROVIDER_PER_AGENT_DAILY,
      resetsAt: new Date('2026-10-17T00:00:00.000Z'),
      fallThroughToPaid: false,
    };

    await expect(h.calls.call(SESSION, TOOL_NAME, ARGS)).rejects.toBeInstanceOf(AppError);
    expect(h.freeQuota.checked[0]).toMatchObject({ pricingMode: PricingMode.FREE });
    expect(h.intents.rows.size).toBe(0);
  });

  // ── review 2026-10-15: M4 (per-binding quota in routing) and M5 (atomic places)

  it('falls through to paid when the free binding the check saw has no room for this agent (M4)', async () => {
    const h = harness();
    h.freeQuota.noRoomFor.add(`binding-${FREE_PROVIDER}`);

    const outcome = await h.calls.call(SESSION, TOOL_NAME, ARGS);

    if (outcome.kind !== 'RESULT') throw new Error('expected a RESULT');
    expect(outcome.receipt.providerId).toBe(PAID_PROVIDER);
    expect(h.invoker.bindingIds).toEqual([`binding-${PAID_PROVIDER}`]);
    // Nothing was served free, so the platform place was given back.
    expect(h.freeQuota.platformPlaces.map((p) => p.released)).toEqual([true]);
  });

  it('answers QUOTA_EXCEEDED on a FREE-only tool whose binding has no room (M4)', async () => {
    const h = buildMcpHarness({
      bindings: [buildBinding(FREE_PROVIDER, { pricingMode: PricingMode.FREE, priceAmount: '0' })],
      providers: [buildProvider(FREE_PROVIDER)],
      stakes: {},
      invoker: new ScriptedInvoker({ [`binding-${FREE_PROVIDER}`]: async () => ok() }),
    });
    h.freeQuota.noRoomFor.add(`binding-${FREE_PROVIDER}`);

    const refusal = await h.calls.call(SESSION, TOOL_NAME, ARGS).catch((e: unknown) => e);

    expect((refusal as AppError).errorCode).toBe('MCP_QUOTA_EXCEEDED');
    expect(h.freeQuota.platformPlaces.map((p) => p.released)).toEqual([true]);
  });

  it('L2: names the dial that shed it — a spent daily budget — and builds it through refuse()', async () => {
    const h = buildMcpHarness({
      bindings: [buildBinding(FREE_PROVIDER, { pricingMode: PricingMode.FREE, priceAmount: '0' })],
      providers: [buildProvider(FREE_PROVIDER)],
      stakes: {},
      invoker: new ScriptedInvoker({ [`binding-${FREE_PROVIDER}`]: async () => ok() }),
    });
    h.freeQuota.noRoomFor.add(`binding-${FREE_PROVIDER}`);
    h.freeQuota.fullOn.set(`binding-${FREE_PROVIDER}`, FreeQuotaLimitKind.PROVIDER_DAILY_BUDGET);

    const refusal = (await h.calls
      .call(SESSION, TOOL_NAME, ARGS)
      .catch((e: unknown) => e)) as AppError;

    expect(refusal.errorCode).toBe('MCP_QUOTA_EXCEEDED');
    expect(h.freeQuota.bindingRefusals).toEqual([FreeQuotaLimitKind.PROVIDER_DAILY_BUDGET]);
    expect(JSON.stringify((refusal as unknown as { context?: unknown }).context)).toContain(
      FreeQuotaLimitKind.PROVIDER_DAILY_BUDGET,
    );
  });

  it('falls through to paid when a parallel call took the last platform place (M5)', async () => {
    const h = harness();
    h.freeQuota.platformRefusal = {
      kind: 'REFUSED',
      limit: FreeQuotaLimitKind.PLATFORM_AGENT_DAILY,
      resetsAt: new Date('2026-10-17T00:00:00.000Z'),
      fallThroughToPaid: true,
    };

    const outcome = await h.calls.call(SESSION, TOOL_NAME, ARGS);

    if (outcome.kind !== 'RESULT') throw new Error('expected a RESULT');
    expect(outcome.receipt.providerId).toBe(PAID_PROVIDER);
    expect(h.freeQuota.places).toEqual([]);
  });

  it('keeps the places of a served free call', async () => {
    const h = harness();

    await h.calls.call(SESSION, TOOL_NAME, ARGS);

    expect(h.freeQuota.platformPlaces.map((p) => p.released)).toEqual([false]);
    expect(h.freeQuota.consumed).toEqual([`binding-${FREE_PROVIDER}`]);
  });
});
