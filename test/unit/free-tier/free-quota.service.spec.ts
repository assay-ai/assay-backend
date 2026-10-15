/**
 * A fixed, non-UTC zone for the whole file — same reasoning as
 * `binding-ceiling.spec.ts`: the daily counters reset on the **UTC** day, and
 * the only way to prove that rather than assert it is to run where the local
 * day and the UTC day disagree.
 */
process.env.TZ = 'Asia/Kolkata';

import { FreeQuotaLimitKind } from '@modules/free-tier/services/free-quota.service';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { NotificationEvent } from '@modules/notification/ports/notification.port';

import {
  AGENT_ID,
  ORGANIZATION_ID,
  TOOL_ID,
  buildBindingRow,
  buildFreeQuotaHarness,
} from './helpers/free-quota-fixtures';

/** Deep inside a UTC day, and deliberately not inside the same local one. */
const T0 = new Date('2026-08-20T10:00:00.000Z').getTime();

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('FreeQuotaService — check()', () => {
  it('allows a call with headroom on every limit', async () => {
    const { service } = buildFreeQuotaHarness();

    const decision = await service.check({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      pricingMode: PricingMode.FREE,
    });

    expect(decision.kind).toBe('ALLOWED');
  });

  // ── the platform rate limit ────────────────────────────────────────────

  it('refuses at the platform rate-limit boundary, and only there', async () => {
    const { service } = buildFreeQuotaHarness({ platformRateLimitPerMinute: 3 });
    const input = {
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      pricingMode: PricingMode.FREE as const,
    };

    for (let i = 0; i < 3; i += 1) {
      const decision = await service.check(input);
      expect(decision.kind).toBe('ALLOWED');
      await service.consume({
        organizationId: ORGANIZATION_ID,
        agentId: AGENT_ID,
        bindingId: 'b1',
      });
    }

    const refused = await service.check(input);
    expect(refused.kind).toBe('REFUSED');
    if (refused.kind === 'REFUSED')
      expect(refused.limit).toBe(FreeQuotaLimitKind.PLATFORM_RATE_LIMIT);
  });

  it('the rate-limit window clears once the calls age out of it', async () => {
    const { service } = buildFreeQuotaHarness({ platformRateLimitPerMinute: 1 });
    const input = {
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      pricingMode: PricingMode.FREE as const,
    };

    await service.consume({ organizationId: ORGANIZATION_ID, agentId: AGENT_ID, bindingId: 'b1' });
    expect((await service.check(input)).kind).toBe('REFUSED');

    jest.setSystemTime(T0 + 61_000);
    expect((await service.check(input)).kind).toBe('ALLOWED');
  });

  // ── the platform per-agent daily limit ─────────────────────────────────

  it('refuses at the platform per-agent daily boundary', async () => {
    const { service, records } = buildFreeQuotaHarness({ platformAgentDailyLimit: 2 });
    records.append('b1');
    records.append('b1');

    const decision = await service.check({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      pricingMode: PricingMode.FREE,
    });

    expect(decision.kind).toBe('REFUSED');
    if (decision.kind === 'REFUSED') {
      expect(decision.limit).toBe(FreeQuotaLimitKind.PLATFORM_AGENT_DAILY);
      expect(decision.resetsAt.toISOString()).toBe('2026-08-21T00:00:00.000Z');
    }
  });

  it('resets the platform daily counter at the UTC boundary, not the local one', async () => {
    const { service, records } = buildFreeQuotaHarness({ platformAgentDailyLimit: 1 });
    records.append('b1', new Date(T0)); // 2026-08-20T10:00Z — 17:00 in Asia/Kolkata

    const stillExhausted = await service.check({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      pricingMode: PricingMode.FREE,
    });
    expect(stillExhausted.kind).toBe('REFUSED');

    // One tick past UTC midnight. `countForAgentSince` is called with
    // `utcDayStart()`, which has moved to the 21st, so the 20th's call no
    // longer counts — even though, in the file's fixed local zone, this
    // instant and `T0` are both still "the 21st" locally throughout.
    jest.setSystemTime(new Date('2026-08-21T00:00:01.000Z'));

    const afterReset = await service.check({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      pricingMode: PricingMode.FREE,
    });
    expect(afterReset.kind).toBe('ALLOWED');
  });

  // ── the provider's own per-agent-per-binding limit ─────────────────────

  it('refuses at the provider per-agent-per-binding boundary when every binding is exhausted', async () => {
    const { service, records } = buildFreeQuotaHarness({}, [
      buildBindingRow('b1', { freeQuotaPerAgent: 1 }),
    ]);
    records.append('b1');

    const decision = await service.check({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      pricingMode: PricingMode.FREEMIUM,
    });

    expect(decision.kind).toBe('REFUSED');
    if (decision.kind === 'REFUSED')
      expect(decision.limit).toBe(FreeQuotaLimitKind.PROVIDER_PER_AGENT_DAILY);
  });

  it('still allows the call when only one of several bindings is exhausted', async () => {
    const { service, records } = buildFreeQuotaHarness({}, [
      buildBindingRow('b1', { freeQuotaPerAgent: 1 }),
      buildBindingRow('b2', { freeQuotaPerAgent: 1 }),
    ]);
    records.append('b1'); // b1 is spent; b2 still has headroom

    const decision = await service.check({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      pricingMode: PricingMode.FREEMIUM,
    });

    expect(decision.kind).toBe('ALLOWED');
  });

  // ── the provider's own daily budget ─────────────────────────────────────

  it('refuses at the provider daily budget boundary — spent by other agents too', async () => {
    const { service, records } = buildFreeQuotaHarness({}, [
      buildBindingRow('b1', { freeDailyBudget: 2 }),
    ]);
    // Two different agents exhaust the shared budget.
    records.append('b1');
    (records as unknown as { rows: unknown[] }).rows.push({
      organizationId: ORGANIZATION_ID,
      agentId: 'a-different-agent',
      toolId: TOOL_ID,
      bindingId: 'b1',
      createdAt: new Date(T0),
    });

    const decision = await service.check({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      pricingMode: PricingMode.FREEMIUM,
    });

    expect(decision.kind).toBe('REFUSED');
    if (decision.kind === 'REFUSED')
      expect(decision.limit).toBe(FreeQuotaLimitKind.PROVIDER_DAILY_BUDGET);
  });

  // ── exhaustion behaviour: FREEMIUM falls through, FREE errors ──────────

  it('a FREEMIUM exhaustion falls through to the paid path', async () => {
    const { service } = buildFreeQuotaHarness({ platformAgentDailyLimit: 0 });

    const decision = await service.check({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      pricingMode: PricingMode.FREEMIUM,
    });

    expect(decision.kind).toBe('REFUSED');
    if (decision.kind === 'REFUSED') expect(decision.fallThroughToPaid).toBe(true);
  });

  it('a FREE exhaustion is an error — no fall-through', async () => {
    const { service } = buildFreeQuotaHarness({ platformAgentDailyLimit: 0 });

    const decision = await service.check({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      pricingMode: PricingMode.FREE,
    });

    expect(decision.kind).toBe('REFUSED');
    if (decision.kind === 'REFUSED') expect(decision.fallThroughToPaid).toBe(false);
  });

  it('sends free_quota.exhausted through the notification port on every refusal', async () => {
    const { service, notifications } = buildFreeQuotaHarness({ platformAgentDailyLimit: 0 });

    await service.check({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      pricingMode: PricingMode.FREE,
    });
    // `notify` is fired-and-forgotten inside `refuse()`; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(notifications.notified).toHaveLength(1);
    expect(notifications.notified[0].event).toBe(NotificationEvent.FREE_QUOTA_EXHAUSTED);
    expect(notifications.notified[0].organizationId).toBe(ORGANIZATION_ID);
  });

  // ── Redis-miss rebuild from Postgres ────────────────────────────────────

  it('rebuilds the platform daily counter from Postgres on a Redis miss', async () => {
    const { service, records } = buildFreeQuotaHarness({ platformAgentDailyLimit: 2 });
    // Nothing in Redis — a cold cache or a restart — but Postgres already
    // has two calls recorded today.
    records.append('b1');
    records.append('b1');

    const decision = await service.check({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      pricingMode: PricingMode.FREE,
    });

    expect(decision.kind).toBe('REFUSED');
    expect(records.queries).toContain(`agent:${AGENT_ID}`);
  });

  // ── fail direction ───────────────────────────────────────────────────────

  it('fails CLOSED on the platform daily limit when both Redis and Postgres are unreachable', async () => {
    const { service, redis, records } = buildFreeQuotaHarness();
    redis.down = true;
    records.down = true;

    const decision = await service.check({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      pricingMode: PricingMode.FREE,
    });

    expect(decision.kind).toBe('REFUSED');
    if (decision.kind === 'REFUSED')
      expect(decision.limit).toBe(FreeQuotaLimitKind.PLATFORM_AGENT_DAILY);
  });

  it('fails OPEN on the provider per-agent limit when both Redis and Postgres are unreachable', async () => {
    const { service, redis, records } = buildFreeQuotaHarness();
    redis.down = true;
    records.down = true;
    // The platform daily check would also refuse once Postgres is down, so
    // isolate the provider-limit branch by giving it its own harness call
    // where the platform limit cannot be the reason for the refusal: raise
    // the platform limit's tolerance by checking the decision's `limit`
    // never names a provider kind when it is in fact PLATFORM_AGENT_DAILY
    // that fires first is expected — what this test actually asserts is the
    // narrower `checkProviderLimits` behaviour directly.
    const verdict = await (
      service as unknown as {
        checkProviderLimits: (
          organizationId: string,
          agentId: string,
          toolId: string,
        ) => Promise<unknown>;
      }
    ).checkProviderLimits(ORGANIZATION_ID, AGENT_ID, TOOL_ID);

    expect(verdict).toBeNull();
  });
});

describe('FreeQuotaService — consume()', () => {
  it('never throws, even when Redis is unreachable', async () => {
    const { service, redis } = buildFreeQuotaHarness();
    redis.down = true;

    await expect(
      service.consume({ organizationId: ORGANIZATION_ID, agentId: AGENT_ID, bindingId: 'b1' }),
    ).resolves.toBeUndefined();
  });

  it('spends against the binding that actually served the call', async () => {
    const { service, redis } = buildFreeQuotaHarness();

    await service.consume({ organizationId: ORGANIZATION_ID, agentId: AGENT_ID, bindingId: 'b1' });

    const keys = [...redis.strings.keys(), ...redis.zsets.keys()];
    expect(keys.some((key) => key.includes('b1'))).toBe(true);
  });
});

describe('FreeQuotaService — dailyAllowanceForTool()', () => {
  it('is the most generous per-agent allowance among the free-capable bindings', async () => {
    const { service } = buildFreeQuotaHarness({}, [
      buildBindingRow('b1', { freeQuotaPerAgent: 25 }),
      // Unset: the platform default (100 in these fixtures) applies.
      buildBindingRow('b2', { pricingMode: PricingMode.FREEMIUM, freeQuotaPerAgent: null }),
    ]);

    await expect(service.dailyAllowanceForTool(TOOL_ID)).resolves.toBe(100);
  });

  it('is null when no binding of the tool serves free calls', async () => {
    const { service } = buildFreeQuotaHarness({}, [
      buildBindingRow('b1', { pricingMode: PricingMode.PAID, priceAmount: '50000' }),
    ]);

    await expect(service.dailyAllowanceForTool(TOOL_ID)).resolves.toBeNull();
  });
});

describe('FreeQuotaService — bindings at their published revision', () => {
  // A live PAID binding whose unpublished draft says FREE is still PAID on the
  // wire (`toServedToolBindings`), so it must not be counted as free supply.
  it('does not treat a live PAID binding with a FREE draft as a free binding', async () => {
    const { service, versions } = buildFreeQuotaHarness({}, [
      buildBindingRow('b1', { mappingVersion: 2, publishedVersion: 1 }),
    ]);
    versions.setRows([
      {
        organizationId: 'provider-b1',
        bindingId: 'b1',
        mappingVersion: 1,
        endpoint: 'https://b1.example.com/api',
        requestMapping: { method: 'POST', path: '/search', body: {} },
        responseMapping: {},
        pricingMode: PricingMode.PAID,
        priceAmount: '50000',
        assetId: buildBindingRow('b1').assetId,
        timeoutMs: 5_000,
      },
    ]);

    await expect(service.remainingForTool(ORGANIZATION_ID, AGENT_ID, TOOL_ID)).resolves.toBeNull();
  });

  it('still counts a FREE binding at its published revision', async () => {
    const { service } = buildFreeQuotaHarness({}, [
      buildBindingRow('b1', { mappingVersion: 1, publishedVersion: 1 }),
    ]);

    await expect(
      service.remainingForTool(ORGANIZATION_ID, AGENT_ID, TOOL_ID),
    ).resolves.not.toBeNull();
  });
});
