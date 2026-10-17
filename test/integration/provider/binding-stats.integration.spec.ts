import { createHash, randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { BindingAttemptRepository } from '@database/postgres/repositories/binding-attempt.repository';
import { BindingStatsRepository } from '@database/postgres/repositories/binding-stats.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { DEFAULT_BINDING_STATS_CONFIG } from '@modules/provider/constants/binding-stats.constants';
import { ChainEnrolmentPort } from '@modules/provider/ports/chain-enrolment.port';
import { BindingStatsService } from '@modules/provider/services/binding-stats.service';
import { DbProviderRegistry } from '@modules/provider/services/db-provider-registry';

import { noBlocks } from '../../unit/helpers/blocklist';
import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

/**
 * The observed-stats pipeline against real Postgres (backlog G1.1):
 * `binding_attempts` and `verification_records` → the refresh →
 * `binding_stats` → `DbProviderRegistry`. Pins the SQL the unit tests stub —
 * the per-binding window, the percentiles, the verdict filter and the prune.
 */
const DATABASE = 'x402_binding_stats_test';
const ASSET = 'eip155:46630/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3';
const PAYEE = 'eip155:46630:0xA271A3407D3302f4b4Fbe469b9188487cedd7d45';
const NOW = new Date('2026-10-17T12:00:00Z');

describe('binding stats, against a real database', () => {
  let dataSource: DataSource;
  let attempts: BindingAttemptRepository;
  let stats: BindingStatsRepository;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    attempts = new BindingAttemptRepository(dataSource);
    stats = new BindingStatsRepository(dataSource);
  }, 300_000);
  afterAll(async () => dataSource?.destroy());

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE binding_attempts, binding_stats, verification_records, payment_intents CASCADE`,
    );
  });

  function service(windowSize = 1000, minSampleSize = 50) {
    return new BindingStatsService(attempts, stats, {
      ...DEFAULT_BINDING_STATS_CONFIG,
      windowSize,
      minSampleSize,
    });
  }

  /** `count` attempts on one binding, `ageMs` old, the newest last. */
  async function seedAttempts(
    bindingId: string,
    providerId: string,
    rows: readonly { available: boolean; latencyMs: number | null }[],
    ageMs = 60_000,
  ): Promise<void> {
    for (const [index, row] of rows.entries()) {
      await dataSource.query(
        `INSERT INTO binding_attempts
           (binding_id, provider_id, call_class, available, latency_ms, reason, created_at)
         VALUES ($1, $2, 'PAID', $3, $4, $5, $6)`,
        [
          bindingId,
          providerId,
          row.available,
          row.latencyMs,
          row.available ? 'OK' : 'UPSTREAM_SERVER_ERROR',
          new Date(NOW.getTime() - ageMs - (rows.length - index) * 1_000),
        ],
      );
    }
  }

  async function seedVerdict(input: {
    bindingId: string;
    providerId: string;
    buyerOrg: string;
    verdict: string;
    lifecycle?: string | null;
  }): Promise<void> {
    const intentId = randomUUID();
    const toolId = randomUUID();
    await dataSource.query(
      `INSERT INTO payment_intents
         (id, organization_id, status, agent_id, agent_account, provider_id, binding_id, tool_id,
          rail, asset_id, decimals, price_amount, provider_amount, platform_fee, request_hash,
          chain_id, expires_at, call_id, call_class, provider_account)
       VALUES ($1, $2, 'SETTLED', $3, $4, $5, $6, $7, 'RAIL_A_PER_CALL', $8, 6, 1000, 1000, 0,
               $9, $10, now() + interval '1 day', $11, 'PAID', $12)`,
      [
        intentId,
        input.buyerOrg,
        randomUUID(),
        `eip155:46630:0x${'1'.repeat(40)}`,
        input.providerId,
        input.bindingId,
        toolId,
        ASSET,
        `sha256:${createHash('sha256').update(intentId).digest('hex')}`,
        'eip155:46630',
        `call-${intentId}`,
        PAYEE,
      ],
    );
    await dataSource.query(
      `INSERT INTO verification_records
         (organization_id, intent_id, tool_id, provider_id, state, request, response,
          verdict_status, lifecycle, decision_policy_id, decision_policy_version,
          evaluated_at, stages, settled_at, settlement_outcome, created_at)
       VALUES ($1, $2, $3, $4, 'SETTLED', '{}'::jsonb, '{}'::jsonb, $5, $6, 'policy-test', 1,
               $7, '[]'::jsonb, $7, 'SETTLE', $7)`,
      [
        input.buyerOrg,
        intentId,
        toolId,
        input.providerId,
        input.verdict,
        input.lifecycle ?? 'ACTIVE',
        new Date(NOW.getTime() - 60_000),
      ],
    );
  }

  async function snapshot(bindingId: string) {
    return (await stats.find({ where: { bindingId } }))[0];
  }

  it('aggregates each binding’s window: availability, latency percentiles and verdicts', async () => {
    const provider = randomUUID();
    const binding = randomUUID();
    const buyer = randomUUID();
    // 100 attempts: 80 answered with latencies 1..80 ms, 20 failed with none.
    await seedAttempts(binding, provider, [
      ...Array.from({ length: 80 }, (_, i) => ({ available: true, latencyMs: i + 1 })),
      ...Array.from({ length: 20 }, () => ({ available: false, latencyMs: null })),
    ]);
    for (let i = 0; i < 9; i += 1) {
      await seedVerdict({
        bindingId: binding,
        providerId: provider,
        buyerOrg: buyer,
        verdict: 'PASS',
      });
    }
    await seedVerdict({
      bindingId: binding,
      providerId: provider,
      buyerOrg: buyer,
      verdict: 'FAIL',
    });
    // None of these is a quality verdict the router may route on.
    await seedVerdict({
      bindingId: binding,
      providerId: provider,
      buyerOrg: buyer,
      verdict: 'SKIPPED',
    });
    await seedVerdict({
      bindingId: binding,
      providerId: provider,
      buyerOrg: buyer,
      verdict: 'FAIL',
      lifecycle: 'SHADOW',
    });
    await seedVerdict({
      bindingId: binding,
      providerId: provider,
      buyerOrg: provider,
      verdict: 'PASS',
    });

    await expect(service().refresh(NOW)).resolves.toEqual({ bindings: 1, pruned: 0 });

    expect(await snapshot(binding)).toEqual(
      expect.objectContaining({
        providerId: provider,
        attempts: 100,
        availableAttempts: 80,
        latencySamples: 80,
        p50LatencyMs: 40,
        p95LatencyMs: 76,
        verdicts: 10,
        passedVerdicts: 9,
      }),
    );

    // And through the registry, with a minimum sample of 10.
    const registry = new DbProviderRegistry(
      {
        find: async () => [{ organizationId: provider, status: 'ACTIVE', tier: 'NEW' }],
      } as unknown as ProviderRepository,
      { enrolmentsOf: async () => new Map() } as unknown as ChainEnrolmentPort,
      noBlocks(),
      null,
      stats,
      { ...DEFAULT_BINDING_STATS_CONFIG, minSampleSize: 10 },
    );
    const state = (await registry.findRoutingStates([provider])).get(provider);
    expect(state?.bindingStats?.get(binding)).toEqual({
      availabilityRate: 0.8,
      paidQualityRate: 0.9,
      p50LatencyMs: 40,
      p95LatencyMs: 76,
    });
  });

  it('keeps only the last N attempts per binding, and nothing older than the max age', async () => {
    const provider = randomUUID();
    const binding = randomUUID();
    const other = randomUUID();
    // Ten old failures, then ten recent successes: a window of ten sees only the successes.
    await seedAttempts(
      binding,
      provider,
      Array.from({ length: 10 }, () => ({ available: false, latencyMs: null })),
      3_600_000,
    );
    await seedAttempts(
      binding,
      provider,
      Array.from({ length: 10 }, () => ({ available: true, latencyMs: 5 })),
    );
    // Eight days old: outside the window whatever N is.
    await seedAttempts(
      other,
      provider,
      [{ available: false, latencyMs: null }],
      8 * 24 * 3_600_000,
    );

    await expect(service(10, 5).refresh(NOW)).resolves.toEqual({ bindings: 1, pruned: 11 });

    expect(await snapshot(binding)).toEqual(
      expect.objectContaining({ attempts: 10, availableAttempts: 10 }),
    );
    expect(await snapshot(other)).toBeUndefined();
    const [{ count }] = await dataSource.query(
      `SELECT count(*)::int AS count FROM binding_attempts`,
    );
    expect(count).toBe(10);
  });

  it('drops a binding whose window emptied from the snapshot', async () => {
    const provider = randomUUID();
    const binding = randomUUID();
    await seedAttempts(binding, provider, [{ available: true, latencyMs: 9 }]);
    await service().refresh(NOW);
    expect(await snapshot(binding)).toBeDefined();

    await dataSource.query(`TRUNCATE binding_attempts`);
    await service().refresh(new Date(NOW.getTime() + 300_000));

    expect(await snapshot(binding)).toBeUndefined();
  });

  it('reads the per-day paid latency for the traffic screen', async () => {
    const provider = randomUUID();
    await seedAttempts(randomUUID(), provider, [
      { available: true, latencyMs: 100 },
      { available: true, latencyMs: 300 },
      { available: false, latencyMs: null },
    ]);

    const rows = await attempts.dailyPaidLatency(
      provider,
      new Date('2026-10-17T00:00:00Z'),
      new Date('2026-10-18T00:00:00Z'),
    );

    expect(rows).toEqual([{ day: '2026-10-17', p50LatencyMs: 100, p95LatencyMs: 300 }]);
  });
});
