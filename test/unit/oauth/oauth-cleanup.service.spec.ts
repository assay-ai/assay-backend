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

  /** Token and code deletes find nothing; the candidate query returns `candidates`. */
  function fakeDataSource(candidates: string[], deleteClient: (id: string) => number | Error) {
    const query = jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT c."id" FROM "oauth_clients"')) {
        return candidates.map((id) => ({ id }));
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

  function service(dataSource: DataSource, withRedis: Redis | null = redis) {
    return new OAuthCleanupService(dataSource, withRedis, {
      now: () => Date.now(),
      verifiedClientIds: [],
    });
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
