import { BindingAttemptRepository } from '@database/postgres/repositories/binding-attempt.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { ProviderTrafficService } from '@modules/provider/services/provider-traffic.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder, fakeRepository } from './helpers/fake-query-builder';

const PROVIDER = 'org-22222222-2222-4222-8222-222222222222';
const WINDOW = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-03T00:00:00.000Z' };

const AGENT_A = 'agent-11111111-1111-4111-8111-111111111111';
const AGENT_B = 'agent-22222222-2222-4222-8222-222222222222';

/**
 * `getTraffic` issues two queries in order: the day/status bucket query,
 * then the per-agent agent/status breakdown query. `dayRows` feeds the first,
 * `agentRows` the second — same technique `fakeRepository` was written for.
 */
function build(
  dayRows: Array<{ day: string; status: string; calls: string }>,
  agentRows: Array<{ agentId: string; status: string; calls: string }> = [],
) {
  const dayFake = fakeQueryBuilder(dayRows);
  const agentFake = fakeQueryBuilder(agentRows);
  const intents = fakeRepository([dayFake.qb, agentFake.qb]) as unknown as PaymentIntentRepository;
  return { service: new ProviderTrafficService(intents), dayFake, agentFake };
}

describe('ProviderTrafficService — filters by provider_id, not organization_id', () => {
  it('scopes both queries to provider_id and still references organization_id (the scope guard)', async () => {
    const { service, dayFake, agentFake } = build([], []);

    await service.getTraffic(PROVIDER, WINDOW);

    for (const fake of [dayFake, agentFake]) {
      const sql = fake.wheres.map((w) => w.sql).join(' ');
      expect(sql).toMatch(/organizationId/);
      expect(sql).toMatch(/providerId/);
      expect(fake.wheres.some((w) => w.params.providerId === PROVIDER)).toBe(true);
    }
  });

  it('refuses from >= to', async () => {
    const { service } = build([]);

    await expectErrorCodeAsync(
      () => service.getTraffic(PROVIDER, { from: WINDOW.to, to: WINDOW.from }),
      ProviderErrorCode.PROVIDER_INVALID_TIME_RANGE,
    );
  });
});

describe('ProviderTrafficService — bucket folding', () => {
  it('zero-fills every PaymentIntentStatus in every bucket, and sums calls honestly', async () => {
    const { service } = build([
      { day: '2026-08-01', status: 'SETTLED', calls: '5' },
      { day: '2026-08-01', status: 'REFUNDED', calls: '2' },
      { day: '2026-08-02', status: 'SETTLED', calls: '3' },
    ]);

    const traffic = await service.getTraffic(PROVIDER, WINDOW);

    expect(traffic.buckets).toHaveLength(2);
    expect(traffic.totalCalls).toBe(10);

    const day1 = traffic.buckets.find((b) => b.day === '2026-08-01')!;
    expect(day1.calls).toBe(7);
    expect(day1.byStatus).toHaveLength(8); // every PaymentIntentStatus member
    expect(day1.byStatus.find((s) => s.status === 'SETTLED')!.calls).toBe(5);
    expect(day1.byStatus.find((s) => s.status === 'REFUNDED')!.calls).toBe(2);
    expect(day1.byStatus.find((s) => s.status === 'VOIDED')!.calls).toBe(0);

    const day2 = traffic.buckets.find((b) => b.day === '2026-08-02')!;
    expect(day2.calls).toBe(3);
  });

  it('leaves latency null when no attempt source is wired', async () => {
    const { service } = build([{ day: '2026-08-01', status: 'SETTLED', calls: '1' }]);

    const traffic = await service.getTraffic(PROVIDER, WINDOW);

    expect(traffic.buckets[0].p50LatencyMs).toBeNull();
    expect(traffic.buckets[0].p95LatencyMs).toBeNull();
  });

  it('fills each day’s latency from the router’s attempts, and null on a day with none', async () => {
    const dayFake = fakeQueryBuilder([
      { day: '2026-08-01', status: 'SETTLED', calls: '4' },
      { day: '2026-08-02', status: 'SETTLED', calls: '1' },
    ]);
    const agentFake = fakeQueryBuilder([]);
    const intents = fakeRepository([
      dayFake.qb,
      agentFake.qb,
    ]) as unknown as PaymentIntentRepository;
    const dailyPaidLatency = jest.fn(async () => [
      { day: '2026-08-01', p50LatencyMs: 180, p95LatencyMs: 950 },
    ]);
    const service = new ProviderTrafficService(intents, {
      dailyPaidLatency,
    } as unknown as BindingAttemptRepository);

    const traffic = await service.getTraffic(PROVIDER, WINDOW);

    expect(dailyPaidLatency).toHaveBeenCalledWith(
      PROVIDER,
      new Date(WINDOW.from),
      new Date(WINDOW.to),
    );
    const [day1, day2] = traffic.buckets;
    expect([day1.p50LatencyMs, day1.p95LatencyMs]).toEqual([180, 950]);
    expect([day2.p50LatencyMs, day2.p95LatencyMs]).toEqual([null, null]);
  });

  it('an empty window is an empty bucket list, not an error', async () => {
    const { service } = build([]);

    const traffic = await service.getTraffic(PROVIDER, WINDOW);

    expect(traffic.buckets).toEqual([]);
    expect(traffic.totalCalls).toBe(0);
  });
});

describe('ProviderTrafficService — per-agent agentId filter', () => {
  it('does not filter by agent_id when agentId is omitted', async () => {
    const { service, dayFake, agentFake } = build([], []);

    await service.getTraffic(PROVIDER, WINDOW);

    for (const fake of [dayFake, agentFake]) {
      expect(fake.wheres.some((w) => /agentId/.test(w.sql))).toBe(false);
    }
  });

  it('adds an agent_id predicate to both queries when agentId is given', async () => {
    const { service, dayFake, agentFake } = build([], []);

    await service.getTraffic(PROVIDER, { ...WINDOW, agentId: AGENT_A });

    for (const fake of [dayFake, agentFake]) {
      expect(fake.wheres.some((w) => /agentId/.test(w.sql) && w.params.agentId === AGENT_A)).toBe(
        true,
      );
    }
  });
});

describe('ProviderTrafficService — per-agent breakdown', () => {
  it('zero-fills every PaymentIntentStatus per agent, and sums calls honestly', async () => {
    const { service } = build(
      [],
      [
        { agentId: AGENT_A, status: 'SETTLED', calls: '5' },
        { agentId: AGENT_A, status: 'REFUNDED', calls: '2' },
        { agentId: AGENT_B, status: 'SETTLED', calls: '1' },
      ],
    );

    const traffic = await service.getTraffic(PROVIDER, WINDOW);

    expect(traffic.agentBreakdown).toHaveLength(2);

    const agentA = traffic.agentBreakdown.find((a) => a.agentId === AGENT_A)!;
    expect(agentA.calls).toBe(7);
    expect(agentA.byStatus).toHaveLength(8);
    expect(agentA.byStatus.find((s) => s.status === 'SETTLED')!.calls).toBe(5);
    expect(agentA.byStatus.find((s) => s.status === 'REFUNDED')!.calls).toBe(2);
    expect(agentA.byStatus.find((s) => s.status === 'VOIDED')!.calls).toBe(0);
  });

  it('orders by calls desc — the busiest agent first', async () => {
    const { service } = build(
      [],
      [
        { agentId: AGENT_A, status: 'SETTLED', calls: '1' },
        { agentId: AGENT_B, status: 'SETTLED', calls: '9' },
      ],
    );

    const traffic = await service.getTraffic(PROVIDER, WINDOW);

    expect(traffic.agentBreakdown.map((a) => a.agentId)).toEqual([AGENT_B, AGENT_A]);
  });

  it('truncates to the top 10 agents by call count', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      agentId: `agent-${String(i).padStart(2, '0')}`,
      status: 'SETTLED',
      calls: String(i + 1),
    }));
    const { service } = build([], rows);

    const traffic = await service.getTraffic(PROVIDER, WINDOW);

    expect(traffic.agentBreakdown).toHaveLength(10);
    // busiest 10 (calls 15 down to 6), in descending order
    expect(traffic.agentBreakdown.map((a) => a.calls)).toEqual([
      15, 14, 13, 12, 11, 10, 9, 8, 7, 6,
    ]);
  });

  it('an empty window is an empty agent breakdown, not an error', async () => {
    const { service } = build([], []);

    const traffic = await service.getTraffic(PROVIDER, WINDOW);

    expect(traffic.agentBreakdown).toEqual([]);
  });
});
