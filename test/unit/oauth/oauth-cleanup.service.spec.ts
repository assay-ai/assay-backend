import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';

import { OAUTH_CLEANUP_BATCH_SIZE } from '@modules/oauth/constants/oauth-cleanup.constants';
import { OAuthCleanupService } from '@modules/oauth/services/oauth-cleanup.service';

/**
 * The fail-safe paths of `OAuthCleanupService` that a real database cannot
 * stage on demand: a client gaining a reference between the candidate query
 * and its delete, an unexpected error, and a Redis that throws.
 */
describe('OAuthCleanupService', () => {
  const redis = { set: jest.fn().mockResolvedValue('OK') } as unknown as Redis;

  /**
   * Token and code deletes find nothing. The candidate query returns
   * `candidates`, or with several batches given, the next batch each time
   * (then nothing).
   */
  function fakeDataSource(
    candidates: string[] | string[][],
    deleteClient: (id: string) => number | Error,
  ) {
    const batches: string[][] = Array.isArray(candidates[0])
      ? [...(candidates as string[][])]
      : [candidates as string[]];
    const query = jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT c."id" FROM "oauth_clients"')) {
        return (batches.shift() ?? []).map((id) => ({ id }));
      }
      if (sql.startsWith('DELETE FROM "oauth_clients"')) {
        const outcome = deleteClient(params[4] as string);
        if (outcome instanceof Error) throw outcome;
        return [[], outcome];
      }
      return [[], 0];
    });
    return { dataSource: { query } as unknown as DataSource, query };
  }

  function service(
    dataSource: DataSource,
    withRedis: Redis | null = redis,
    now: () => number = () => Date.now(),
  ) {
    return new OAuthCleanupService(dataSource, withRedis, { now, verifiedClientIds: [] });
  }

  function ids(prefix: string, count: number): string[] {
    return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
  }

  function selectCount(query: jest.Mock): number {
    return query.mock.calls.filter(([sql]) => (sql as string).startsWith('SELECT c."id"')).length;
  }

  function fkViolation(): Error {
    return Object.assign(new Error('violates foreign key constraint'), { code: '23503' });
  }

  it('keeps a client whose delete hits the FK (23503) and goes on to the next', async () => {
    const { dataSource } = fakeDataSource(['held', 'free'], (id) =>
      id === 'held' ? fkViolation() : 1,
    );

    await expect(service(dataSource).run()).resolves.toMatchObject({
      skipped: false,
      clients: 1,
    });
  });

  it('rethrows any other error', async () => {
    const { dataSource } = fakeDataSource(['broken'], () =>
      Object.assign(new Error('connection lost'), { code: '08006' }),
    );

    await expect(service(dataSource).run()).rejects.toThrow('connection lost');
  });

  it('re-checks age, idleness, CIMD fetch, verified list and references in each delete', async () => {
    const { dataSource, query } = fakeDataSource(['one'], () => 1);

    await service(dataSource).run();

    const [deleteSql] = query.mock.calls.find(([sql]) =>
      (sql as string).startsWith('DELETE FROM "oauth_clients"'),
    ) as [string, unknown[]];
    for (const clause of [
      'c."id" = $5',
      'c."cache_until" < $4',
      'c."kind" = ANY($1)',
      'c."created_at" < $2',
      'c."last_used_at" < $2',
      'c."fetched_at" < $2',
      'NOT (c."client_id" = ANY($3))',
      'FROM "agent_credentials"',
      'FROM "oauth_authorization_codes"',
    ]) {
      expect(deleteSql).toContain(clause);
    }
  });

  it('bounds the candidate list, oldest first', async () => {
    const { dataSource, query } = fakeDataSource([], () => 0);

    await service(dataSource).run();

    const [selectSql, params] = query.mock.calls.find(([sql]) =>
      (sql as string).startsWith('SELECT c."id"'),
    ) as [string, unknown[]];
    expect(selectSql).toMatch(/ORDER BY c\."created_at" LIMIT \$5/);
    expect(params[4]).toBe(OAUTH_CLEANUP_BATCH_SIZE);
  });

  it('fetches another batch after a full one, until a batch comes back short', async () => {
    const { dataSource, query } = fakeDataSource(
      [ids('a', OAUTH_CLEANUP_BATCH_SIZE), ids('b', OAUTH_CLEANUP_BATCH_SIZE), ids('c', 2)],
      () => 1,
    );

    await expect(service(dataSource).run()).resolves.toMatchObject({
      clients: 2 * OAUTH_CLEANUP_BATCH_SIZE + 2,
    });
    expect(selectCount(query)).toBe(3);
  });

  it('starts no batch once 45 minutes of the run are spent', async () => {
    const { dataSource, query } = fakeDataSource(
      [ids('a', OAUTH_CLEANUP_BATCH_SIZE), ids('b', OAUTH_CLEANUP_BATCH_SIZE)],
      () => 1,
    );
    const start = Date.UTC(2026, 0, 1, 3, 17);
    let clock = start;
    // Time passes only while clients are deleted: the first batch takes 46 min.
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT c."id"')) {
        return selectCount(query) === 1
          ? ids('a', OAUTH_CLEANUP_BATCH_SIZE).map((id) => ({ id }))
          : [];
      }
      if (sql.startsWith('DELETE FROM "oauth_clients"')) {
        clock += Math.ceil((46 * 60_000) / OAUTH_CLEANUP_BATCH_SIZE);
        return [[], 1];
      }
      return [[], 0];
    });

    await expect(service(dataSource, redis, () => clock).run()).resolves.toMatchObject({
      clients: OAUTH_CLEANUP_BATCH_SIZE,
    });
    expect(selectCount(query)).toBe(1);
    expect(clock - start).toBeGreaterThanOrEqual(45 * 60_000);
  });

  it('passes an expired-cache cutoff one hour before now', async () => {
    const { dataSource, query } = fakeDataSource([], () => 0);
    const now = Date.UTC(2026, 0, 1, 3, 17);

    await service(dataSource, redis, () => now).run();

    const [, params] = query.mock.calls.find(([sql]) =>
      (sql as string).startsWith('SELECT c."id"'),
    ) as [string, unknown[]];
    expect(params[3]).toEqual(new Date(now - 3_600_000));
  });

  it('a full batch that deletes nothing ends the pass', async () => {
    const { dataSource, query } = fakeDataSource(
      [ids('a', OAUTH_CLEANUP_BATCH_SIZE), ids('b', 1)],
      () => 0,
    );

    await expect(service(dataSource).run()).resolves.toMatchObject({ clients: 0 });
    expect(selectCount(query)).toBe(1);
  });

  it('is skipped, touching nothing, when Redis throws', async () => {
    const { dataSource, query } = fakeDataSource(['one'], () => 1);
    const failing = { set: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };

    await expect(service(dataSource, failing as unknown as Redis).run()).resolves.toEqual({
      skipped: true,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('is skipped, touching nothing, without Redis', async () => {
    const { dataSource, query } = fakeDataSource(['one'], () => 1);

    await expect(service(dataSource, null).run()).resolves.toEqual({ skipped: true });
    expect(query).not.toHaveBeenCalled();
  });
});
