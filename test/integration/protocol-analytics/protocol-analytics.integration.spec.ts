import { ProtocolAnalyticsReadIndexes1793232000000 } from '@database/postgres/migrations/1793232000000-protocol-analytics-read-indexes';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { DataSource } from 'typeorm';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import Redis from 'ioredis';
import request from 'supertest';

import { ProtocolAnalyticsController } from '@modules/protocol-analytics/controllers/protocol-analytics.controller';
import { ProtocolAnalyticsService } from '@modules/protocol-analytics/services/protocol-analytics.service';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { CacheHeaderInterceptor } from '@shared/interceptors/cache-header.interceptor';
import { TransformInterceptor } from '@shared/interceptors/transform.interceptor';

import { analyticsWindow } from '@modules/protocol-analytics/domain/analytics-window';
import { ProtocolAnalyticsRepository } from '@database/postgres/repositories/protocol-analytics.repository';
import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

// Dedicated local test database, real application migrations, no production connection.
let ASSET: string;
const NOW = new Date('2026-10-29T12:30:00Z');
const BUYER_ORG = randomUUID();
const PUBLIC_TOOL = randomUUID();
const PRIVATE_TOOL = randomUUID();
let voucherSeq = 1;

describe('Protocol analytics SQL against PostgreSQL', () => {
  let db: DataSource;
  let repository: ProtocolAnalyticsRepository;

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '::1'].includes(testConnectionOptions().host)) {
      throw new Error('Protocol analytics integration tests require a local PostgreSQL server');
    }
    const database = await ensureTestDatabase('assay_protocol_analytics_test');
    db = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database,
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      logging: false,
      extra: { max: 1 },
      migrationsTransactionMode: 'each',
    });
    await db.initialize();
    await db.runMigrations();
    repository = new ProtocolAnalyticsRepository(db);
  });

  afterAll(async () => {
    await db?.destroy();
  });

  beforeEach(async () => {
    // This database belongs to this suite; no shared development data is touched.
    ASSET = `eip155:46630/erc20:0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`;
    await db.query(
      `INSERT INTO tools (id, name, kind, visibility, category, status, owner_org_id, review_status) VALUES
      ($1, 'analytics_public_${PUBLIC_TOOL.slice(0, 8)}', 'STANDARD', 'LISTED', 'search', 'ACTIVE', NULL, NULL),
      ($2, 'analytics__private_${PRIVATE_TOOL.slice(0, 8)}', 'PROVIDER', 'PRIVATE', 'search', 'ACTIVE', $3, 'NONE') ON CONFLICT (id) DO NOTHING`,
      [PUBLIC_TOOL, PRIVATE_TOOL, BUYER_ORG],
    );
  });

  async function call(
    options: {
      outcome?: 'collected' | 'refunded' | 'pending' | 'voided' | 'lapsed' | 'unredeemed';
      organization?: string;
      asset?: string;
      tool?: string;
      created?: string;
      callClass?: string;
      amount?: string;
    } = {},
  ) {
    const id = randomUUID();
    const hold = randomUUID();
    const org = options.organization ?? BUYER_ORG;
    const outcome = options.outcome ?? 'collected';
    const amount = options.amount ?? '1000000';
    const created = options.created ?? '2026-10-29T10:00:00Z';
    const released = outcome === 'pending' || outcome === 'unredeemed' ? null : created;
    const heldStatus =
      outcome === 'collected' ? 'COLLECTED' : outcome === 'refunded' ? 'REFUNDED' : null;
    const status =
      outcome === 'pending'
        ? 'VERIFYING'
        : outcome === 'refunded'
          ? 'REFUNDED'
          : outcome === 'voided'
            ? 'VOIDED'
            : 'SETTLED';
    await db.query(
      `INSERT INTO ledger_holds
      (id,organization_id,account_id,amount,asset_id,decimals,status,intent_id,create_entry_id,created_at,resolve_entry_id)
      VALUES ($1,$2,$3,$4,$5,6,$6,$7,$8,$9,$10)`,
      [
        hold,
        org,
        `eip155:46630:0x${org.replaceAll('-', '').padEnd(40, '0')}`,
        amount,
        options.asset ?? ASSET,
        outcome === 'pending' || outcome === 'unredeemed'
          ? 'OPEN'
          : outcome === 'collected'
            ? 'COMMITTED'
            : 'RELEASED',
        id,
        randomUUID(),
        created,
        outcome === 'pending' || outcome === 'unredeemed' ? null : randomUUID(),
      ],
    );
    await db.query(
      `INSERT INTO payment_intents
      (id,organization_id,status,agent_id,agent_account,provider_id,provider_account,tool_id,rail,
       call_id,call_class,asset_id,decimals,price_amount,provider_amount,platform_fee,request_hash,
       chain_id,expires_at,hold_id,hold_released_at,held_status,created_at,redemption_last_error,voucher_seq,held_at,collectable_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'RAIL_B_VOUCHER',$9,$10,$11,6,$12,$13,$14,'hash',
        'eip155:46630',$15,$16,$17,$18,$19,$20,$21,$19,$15)`,
      [
        id,
        org,
        status,
        randomUUID(),
        `eip155:46630:0x${org.replaceAll('-', '').padEnd(40, '0')}`,
        BUYER_ORG,
        'eip155:46630:0x1111111111111111111111111111111111111111',
        options.tool ?? PUBLIC_TOOL,
        randomUUID(),
        options.callClass ?? 'PAID',
        options.asset ?? ASSET,
        amount,
        ((BigInt(amount) * 9n) / 10n).toString(),
        (BigInt(amount) / 10n).toString(),
        NOW,
        hold,
        released,
        heldStatus,
        created,
        outcome === 'lapsed' ? 'uncollected:written_off' : null,
        voucherSeq++,
      ],
    );
    if (outcome === 'collected') {
      for (const [type, value] of [
        ['PLATFORM_FEE', BigInt(amount) / 10n],
        ['PROVIDER_CREDIT', (BigInt(amount) * 9n) / 10n],
      ] as const) {
        await db.query(
          `INSERT INTO ledger_entries
          (id,organization_id,account_id,entry_type,amount,asset_id,decimals,intent_id,created_at)
          VALUES ($1,$2,'platform',$3,$4,$5,6,$6,$7)`,
          [randomUUID(), org, type, value.toString(), options.asset ?? ASSET, id, created],
        );
      }
    }
    return id;
  }

  it('returns genuine zeros and null pass rate for an empty asset', async () => {
    const result = await repository.read(ASSET, analyticsWindow('7d', NOW));
    expect(result.totals.paidCalls).toBe(0);
    expect(result.totals.revenue).toBe('0');
    expect(result.totals.passRate).toBeNull();
    expect(result.daily).toHaveLength(7);
    expect(result.daily.every((day) => day.volume === '0')).toBe(true);
    expect(result.topTools).toEqual([]);
  });

  it('reconciles collected, refunded, pending and released amounts without counting free or other assets', async () => {
    await call();
    await call({ outcome: 'refunded' });
    await call({ outcome: 'pending' });
    await call({ outcome: 'voided' });
    await call({ outcome: 'lapsed' });
    await call({ callClass: 'TEST' });
    await call({ callClass: 'FREE' });
    await call({ asset: 'eip155:46630/erc20:0x2222222222222222222222222222222222222222' });
    const result = await repository.read(ASSET, analyticsWindow('7d', NOW));
    expect(result.totals).toMatchObject({
      paidCalls: 5,
      collectedCalls: 1,
      refundedCalls: 1,
      pendingCalls: 1,
      revenue: '100000',
      providerEarnings: '900000',
      refunded: '1000000',
      pending: '1000000',
      notCharged: '2000000',
      volume: '5000000',
      passRate: 0.5,
    });
    expect(result.topTools).toEqual([]);
    expect(result.recent).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(BUYER_ORG);
    expect(JSON.stringify(result)).not.toContain('0x111111');
  });

  it('filters assets, counts distinct payer wallets, excludes private/small groups and keeps all-time growth', async () => {
    await call({ created: '2026-01-01T10:00:00Z' });
    await call({ tool: PRIVATE_TOOL });
    await call({ organization: randomUUID() });
    const week = await repository.read(ASSET, analyticsWindow('7d', NOW));
    expect(week.totals.payingAgents).toBe(2);
    expect(week.topTools).toEqual([]);
    expect(week.recent).toEqual([]);
    expect(week.withheldForPrivacy).toBe(true);
    expect(week.daily.at(-1)?.agentsSinceLaunch).toBe(2);
    const all = await repository.read(ASSET, analyticsWindow('all', NOW));
    expect(all.previous).toBeNull();
    expect(all.daily).toHaveLength(90);
    expect(all.totals.paidCalls).toBe(3);
  });

  it('uses exact numeric amounts above the JavaScript safe-integer range', async () => {
    await call({ amount: '100000000000000000000' });
    const result = await repository.read(ASSET, analyticsWindow('7d', NOW));
    expect(result.totals.volume).toBe('100000000000000000000');
    expect(result.totals.revenue).toBe('10000000000000000000');
  });

  it('applies the same accounting rules to calls from every buyer organization', async () => {
    await call();
    await call({ organization: randomUUID() });
    const result = await repository.read(ASSET, analyticsWindow('7d', NOW));
    expect(result.totals).toMatchObject({
      paidCalls: 2,
      payingAgents: 2,
      revenue: '200000',
      volume: '2000000',
    });
    expect(Object.keys(result.totals).sort()).toEqual(
      [
        'paidCalls',
        'payingAgents',
        'toolsEarning',
        'collectedCalls',
        'refundedCalls',
        'pendingCalls',
        'volume',
        'revenue',
        'providerEarnings',
        'refunded',
        'pending',
        'notCharged',
        'passRate',
      ].sort(),
    );
  });

  it('does not report a served but unredeemed voucher as collected revenue', async () => {
    await call({ outcome: 'unredeemed' });
    const result = await repository.read(ASSET, analyticsWindow('7d', NOW));
    expect(result.totals).toMatchObject({
      paidCalls: 1,
      collectedCalls: 0,
      pendingCalls: 1,
      revenue: '0',
      providerEarnings: '0',
      pending: '1000000',
      passRate: null,
      toolsEarning: 0,
    });
  });

  it('publishes only the allowlisted group fields once five buyers are present', async () => {
    for (let i = 0; i < 5; i++) await call({ organization: randomUUID() });
    const result = await repository.read(ASSET, analyticsWindow('7d', NOW));
    expect(result.topTools).toHaveLength(1);
    expect(result.recent).toHaveLength(1);
    expect(result.topTools[0].paidCalls).toBe(5);
    expect(Object.keys(result.topTools[0]).sort()).toEqual(
      [
        'category',
        'collectedCalls',
        'name',
        'paidCalls',
        'passRate',
        'refundedCalls',
        'volume',
      ].sort(),
    );
    expect(Object.keys(result.recent[0]).sort()).toEqual(
      ['collectedCalls', 'day', 'paidCalls', 'refundedCalls', 'tool', 'volume'].sort(),
    );
  });

  it('keeps UTC day buckets independent of the database session zone', async () => {
    await call({ created: '2026-10-29T00:30:00+14:00' });
    await db.query("SET TIME ZONE 'Pacific/Auckland'");
    try {
      const result = await repository.read(ASSET, analyticsWindow('7d', NOW));
      expect(result.daily.find((day) => day.day === '2026-10-28')?.paidCalls).toBe(1);
      expect(result.daily.find((day) => day.day === '2026-10-29')?.paidCalls).toBe(0);
    } finally {
      await db.query("SET TIME ZONE 'UTC'");
    }
  });

  it('counts only buyer escrow ledger balances without double-counting provider/platform accounts', async () => {
    const account = `eip155:46630:0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`;
    await db.query(
      `INSERT INTO buyer_escrows (id,organization_id,account_id,asset_id,escrow_account_id,escrow_asset_account_id)
      VALUES ($1,$2,$3,$4,'escrow','asset-account')`,
      [randomUUID(), BUYER_ORG, account, ASSET],
    );
    await db.query(
      `INSERT INTO account_balances (id,organization_id,account_id,asset_id,decimals,available,held,pending)
      VALUES ($1,$2,$3,$4,6,1234567,500000,0),($5,$2,'platform:fees',$4,6,99999999,0,0)`,
      [randomUUID(), BUYER_ORG, account, ASSET, randomUUID()],
    );
    const result = await repository.read(ASSET, analyticsWindow('7d', NOW));
    expect(result.escrow).toEqual({ available: '1234567', held: '500000' });
  });

  it('fails rather than mixing records with inconsistent atomic scales', async () => {
    await call();
    await expect(repository.read(ASSET, analyticsWindow('7d', NOW), 9)).rejects.toThrow(
      'scale is inconsistent',
    );
  });

  it('can revert the read indexes in a transaction and rebuild them idempotently', async () => {
    const migration = new ProtocolAnalyticsReadIndexes1793232000000();
    const runner = db.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      await migration.down(runner);
      await runner.commitTransaction();
      await migration.up(runner);
      await migration.up(runner);
      const indexes =
        await runner.query(`SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        WHERE c.relname IN ('idx_protocol_analytics_funded','idx_protocol_analytics_entries') AND i.indisvalid`);
      expect(indexes).toHaveLength(2);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('serves an anonymous no-store HTTP API and observes new database writes after the real Redis TTL', async () => {
    const port = Number(process.env.ANALYTICS_TEST_REDIS_PORT || '56379');
    const redis = new Redis({
      host: '127.0.0.1',
      port,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    await redis.connect();
    const config = new ConfigService();
    const module = await Test.createTestingModule({
      controllers: [ProtocolAnalyticsController],
      providers: [
        ProtocolAnalyticsService,
        ProtocolAnalyticsRepository,
        { provide: getDataSourceToken('postgres'), useValue: db },
        { provide: ConfigService, useValue: config },
        { provide: ENABLED_CHAINS, useValue: [CHAIN_IDS.ROBINHOOD_TESTNET] },
        { provide: REDIS_CACHE_CLIENT, useValue: redis },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.useGlobalInterceptors(
      new CacheHeaderInterceptor(new Reflector(), config),
      new TransformInterceptor(),
    );
    await app.init();
    try {
      const route = '/public/analytics?range=7d';
      const before = await request(app.getHttpServer()).get(route).expect(200);
      expect(before.headers['cache-control']).toContain('no-store');
      expect(before.headers['cdn-cache-control']).toBe('no-store');
      expect(before.body.data.cacheTtlMs).toBe(2000);
      await request(app.getHttpServer()).get('/public/analytics?range=invalid').expect(400);
      await request(app.getHttpServer()).get('/public/analytics?asset=disabled').expect(400);
      await call({
        asset: ASSET_IDS.USDG_ROBINHOOD_TESTNET!,
        created: new Date(Date.now() - 1000).toISOString(),
      });
      const cached = await request(app.getHttpServer()).get(route).expect(200);
      expect(cached.body.data.generatedAt).toBe(before.body.data.generatedAt);
      await new Promise((resolve) => setTimeout(resolve, 2100));
      const fresh = await request(app.getHttpServer()).get(route).expect(200);
      expect(fresh.body.data.totals.paidCalls).toBe(before.body.data.totals.paidCalls + 1);
      expect(BigInt(fresh.body.data.totals.revenue) - BigInt(before.body.data.totals.revenue)).toBe(
        100000n,
      );
      expect(fresh.body.data.generatedAt).not.toBe(before.body.data.generatedAt);
      expect(fresh.body.data.daily).toHaveLength(7);
      const payload = JSON.stringify(fresh.body.data);
      expect(payload).not.toContain(BUYER_ORG);
      expect(payload).not.toContain('agent_account');
    } finally {
      await app.close();
      await redis.quit();
    }
  });
});
