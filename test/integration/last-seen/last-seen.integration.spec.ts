import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { CacheService } from '@shared/cache/redis-cache/cache.service';
import {
  LastSeenKind,
  LastSeenRecorder,
  credentialKey,
  flushingKey,
  pendingKey,
} from '@shared/last-seen';
import { LAST_SEEN_FLUSH_LOCK_KEY, LastSeenFlusher } from '@shared/last-seen/last-seen.flusher';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

/**
 * B1: "last seen" stamps go to Redis and reach Postgres in batches. Against a
 * real Redis and a real Postgres (the three target tables reduced to the
 * columns the writes touch), this proves the row ends up holding exactly what
 * the direct per-request write would have left in it (the latest stamp), that
 * a reader overlaying the buffer sees that value before any flush, and that
 * no stamp is lost across a flush, a failed write or a Redis outage.
 */
describe('LastSeenRecorder + LastSeenFlusher', () => {
  let dataSource: DataSource;
  let redis: Redis;
  let recorder: LastSeenRecorder;
  let flusher: LastSeenFlusher;

  const cacheOf = (client: Redis) => ({ getRedisClient: () => client }) as unknown as CacheService;

  beforeAll(async () => {
    const database = await ensureTestDatabase('assay_last_seen_test');
    dataSource = new DataSource({ type: 'postgres', ...testConnectionOptions(), database });
    await dataSource.initialize();
    await dataSource.query(`DROP TABLE IF EXISTS agents, agent_credentials, operators`);
    await dataSource.query(`CREATE TABLE agents (id uuid PRIMARY KEY, last_login_at timestamptz)`);
    await dataSource.query(
      `CREATE TABLE agent_credentials (id uuid PRIMARY KEY, organization_id uuid NOT NULL,
         last_used_at timestamptz)`,
    );
    await dataSource.query(
      `CREATE TABLE operators (id uuid PRIMARY KEY, last_seen_at timestamptz)`,
    );

    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
    });
    recorder = new LastSeenRecorder(dataSource, cacheOf(redis));
    flusher = new LastSeenFlusher(dataSource, cacheOf(redis));
  });

  afterAll(async () => {
    redis?.disconnect();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    for (const kind of Object.values(LastSeenKind)) {
      await redis.del(pendingKey(kind), flushingKey(kind));
    }
    await redis.del(LAST_SEEN_FLUSH_LOCK_KEY);
    await dataSource.query(`TRUNCATE agents, agent_credentials, operators`);
  });

  /** `record` is fire-and-forget; wait until its write is visible. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const at = (iso: string) => new Date(iso);
  const one = async <T>(sql: string, params: unknown[]): Promise<T> =>
    ((await dataSource.query(sql, params)) as T[])[0];

  it('leaves each row holding its latest stamp, as the direct writes did, in one flush', async () => {
    const agent = randomUUID();
    const operator = randomUUID();
    const organization = randomUUID();
    const credential = randomUUID();
    await dataSource.query(`INSERT INTO agents (id) VALUES ($1)`, [agent]);
    await dataSource.query(`INSERT INTO operators (id, last_seen_at) VALUES ($1, $2)`, [
      operator,
      at('2026-10-20T09:00:00.000Z'),
    ]);
    await dataSource.query(`INSERT INTO agent_credentials (id, organization_id) VALUES ($1, $2)`, [
      credential,
      organization,
    ]);

    // Out of order, as two replicas would deliver them.
    for (const iso of [
      '2026-10-20T10:00:02.000Z',
      '2026-10-20T10:00:05.000Z',
      '2026-10-20T10:00:01.000Z',
    ]) {
      recorder.record(LastSeenKind.AGENT_LOGIN, agent, at(iso));
      recorder.record(LastSeenKind.OPERATOR_SEEN, operator, at(iso));
      recorder.record(
        LastSeenKind.CREDENTIAL_USE,
        credentialKey(organization, credential),
        at(iso),
      );
    }
    await settle();

    // Before any flush, a reader overlaying the buffer sees the latest stamp.
    const pending = await recorder.pending(LastSeenKind.CREDENTIAL_USE, [
      credentialKey(organization, credential),
    ]);
    expect(pending.get(credentialKey(organization, credential))?.toISOString()).toBe(
      '2026-10-20T10:00:05.000Z',
    );
    expect(
      (await one<{ last_used_at: Date | null }>(`SELECT last_used_at FROM agent_credentials`, []))
        .last_used_at,
    ).toBeNull();

    const summary = await flusher.flush();
    expect(summary.written).toEqual({
      [LastSeenKind.AGENT_LOGIN]: 1,
      [LastSeenKind.CREDENTIAL_USE]: 1,
      [LastSeenKind.OPERATOR_SEEN]: 1,
    });

    const latest = '2026-10-20T10:00:05.000Z';
    expect((await one<{ t: Date }>(`SELECT last_login_at t FROM agents`, [])).t.toISOString()).toBe(
      latest,
    );
    expect(
      (await one<{ t: Date }>(`SELECT last_seen_at t FROM operators`, [])).t.toISOString(),
    ).toBe(latest);
    expect(
      (await one<{ t: Date }>(`SELECT last_used_at t FROM agent_credentials`, [])).t.toISOString(),
    ).toBe(latest);
    // Flushed and gone from Redis.
    expect(await redis.exists(pendingKey(LastSeenKind.AGENT_LOGIN))).toBe(0);
    expect(await redis.exists(flushingKey(LastSeenKind.AGENT_LOGIN))).toBe(0);
  });

  it('never moves a column backwards', async () => {
    const agent = randomUUID();
    await dataSource.query(`INSERT INTO agents (id, last_login_at) VALUES ($1, $2)`, [
      agent,
      at('2026-10-20T12:00:00.000Z'),
    ]);
    recorder.record(LastSeenKind.AGENT_LOGIN, agent, at('2026-10-20T11:00:00.000Z'));
    await settle();
    await flusher.flush();
    expect((await one<{ t: Date }>(`SELECT last_login_at t FROM agents`, [])).t.toISOString()).toBe(
      '2026-10-20T12:00:00.000Z',
    );
  });

  it('matches a credential on its organization too', async () => {
    const credential = randomUUID();
    const organization = randomUUID();
    await dataSource.query(`INSERT INTO agent_credentials (id, organization_id) VALUES ($1, $2)`, [
      credential,
      organization,
    ]);
    recorder.record(LastSeenKind.CREDENTIAL_USE, credentialKey(randomUUID(), credential));
    await settle();
    await flusher.flush();
    expect(
      (await one<{ t: Date | null }>(`SELECT last_used_at t FROM agent_credentials`, [])).t,
    ).toBeNull();
  });

  it('keeps a twin whose write failed, overlays it, and writes it on the next flush', async () => {
    const agent = randomUUID();
    await dataSource.query(`INSERT INTO agents (id) VALUES ($1)`, [agent]);
    recorder.record(LastSeenKind.AGENT_LOGIN, agent, at('2026-10-20T10:00:00.000Z'));
    await settle();

    const failing = new LastSeenFlusher(
      { query: () => Promise.reject(new Error('database down')) } as unknown as DataSource,
      cacheOf(redis),
    );
    await failing.flush();
    expect(await redis.exists(flushingKey(LastSeenKind.AGENT_LOGIN))).toBe(1);

    // A stamp recorded meanwhile goes to a fresh hash, and both are overlaid.
    recorder.record(LastSeenKind.AGENT_LOGIN, agent, at('2026-10-20T10:00:09.000Z'));
    await settle();
    expect(
      (await recorder.pending(LastSeenKind.AGENT_LOGIN, [agent])).get(agent)?.toISOString(),
    ).toBe('2026-10-20T10:00:09.000Z');

    await flusher.flush();
    expect((await one<{ t: Date }>(`SELECT last_login_at t FROM agents`, [])).t.toISOString()).toBe(
      '2026-10-20T10:00:09.000Z',
    );
    expect(await redis.exists(flushingKey(LastSeenKind.AGENT_LOGIN))).toBe(0);
    expect(await redis.exists(pendingKey(LastSeenKind.AGENT_LOGIN))).toBe(0);
  });

  it('loses no stamp recorded while a flush runs', async () => {
    const agents: string[] = Array.from({ length: 50 }, () => randomUUID());
    for (const id of agents) await dataSource.query(`INSERT INTO agents (id) VALUES ($1)`, [id]);
    const base = Date.parse('2026-10-20T10:00:00.000Z');
    agents.forEach((id, i) => recorder.record(LastSeenKind.AGENT_LOGIN, id, new Date(base + i)));
    await settle();

    const flushing = flusher.flush();
    agents.forEach((id, i) =>
      recorder.record(LastSeenKind.AGENT_LOGIN, id, new Date(base + 1_000 + i)),
    );
    await flushing;
    await settle();
    await flusher.flush();

    const rows = (await dataSource.query(`SELECT id, last_login_at FROM agents`)) as {
      id: string;
      last_login_at: Date;
    }[];
    for (const row of rows) {
      expect(row.last_login_at.getTime()).toBe(base + 1_000 + agents.indexOf(row.id));
    }
  });

  it('skips a flush another replica is running', async () => {
    await redis.set(LAST_SEEN_FLUSH_LOCK_KEY, 'someone-else', 'PX', 5_000);
    expect((await flusher.flush()).skipped).toBe(true);
  });

  it('writes directly, at most once a minute per key, when Redis is unreachable', async () => {
    const agent = randomUUID();
    await dataSource.query(`INSERT INTO agents (id) VALUES ($1)`, [agent]);
    const down = new Redis({
      port: 1,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    const offline = new LastSeenRecorder(dataSource, cacheOf(down));
    const spy = jest.spyOn(dataSource, 'query');

    offline.record(LastSeenKind.AGENT_LOGIN, agent, at('2026-10-20T10:00:00.000Z'));
    await new Promise((resolve) => setTimeout(resolve, 700));
    offline.record(LastSeenKind.AGENT_LOGIN, agent, at('2026-10-20T10:00:30.000Z'));
    await new Promise((resolve) => setTimeout(resolve, 700));
    const writes = spy.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE "agents"'));
    expect(writes).toHaveLength(1);
    expect((await one<{ t: Date }>(`SELECT last_login_at t FROM agents`, [])).t.toISOString()).toBe(
      '2026-10-20T10:00:00.000Z',
    );

    offline.record(LastSeenKind.AGENT_LOGIN, agent, at('2026-10-20T10:01:01.000Z'));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect((await one<{ t: Date }>(`SELECT last_login_at t FROM agents`, [])).t.toISOString()).toBe(
      '2026-10-20T10:01:01.000Z',
    );
    expect(await offline.pending(LastSeenKind.AGENT_LOGIN, [agent])).toEqual(new Map());
    spy.mockRestore();
    down.disconnect();
  });
});
