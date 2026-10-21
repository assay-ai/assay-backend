import { AsyncLocalStorage } from 'node:async_hooks';
import { randomInt } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { DataSource, EntityManager, EntitySubscriberInterface, QueryRunner } from 'typeorm';

import { CacheService } from './cache.service';
import { readEpoch } from './epoch-counter';
import { withRedisTimeout } from './with-redis-timeout';

/**
 * The named parts of an organization's data a cached read can depend on.
 *
 * A cached response (`@TenantCache`) is keyed on the current value of every
 * scope it names, so a write that bumps one of them makes the old entries
 * unreachable at once — no key scan, no delete, and every API instance sees it
 * on its next read.
 *
 * - `money`: ledger, holds, deposits, withdrawals, payment intents, debts,
 *   escrow and delegates — everything a balance, a summary or a call list shows.
 * - `notifications`: the in-app inbox and its unread count.
 * - `agents`: agents, their credentials, delegate bindings and servers in use.
 * - `toolsets`: toolsets, versions, an agent's access and spend policy.
 * - `provider`: the provider console of the organization (registration,
 *   bindings, stake, earnings, verdicts, slash holds).
 * - `disputes`: call disputes the organization filed or must answer.
 * - `operator`: one global scope for the cross-tenant operator console.
 * - `shared`: one global scope for what one organization publishes that
 *   others read (shared toolsets, provider tools, handles) — bumped with
 *   `AccessEpochService.bumpShared`.
 */
export const TENANT_EPOCH_SCOPES = [
  'money',
  'notifications',
  'agents',
  'toolsets',
  'provider',
  'disputes',
  'operator',
  'shared',
] as const;

export type TenantEpochScope = (typeof TENANT_EPOCH_SCOPES)[number];

/** The scope that is never per organization. */
export const GLOBAL_EPOCH_SCOPES: ReadonlySet<TenantEpochScope> = new Set(['operator', 'shared']);

/** Every per-organization scope: what a write by the organization may touch. */
export const ORGANIZATION_EPOCH_SCOPES: readonly TenantEpochScope[] = TENANT_EPOCH_SCOPES.filter(
  (scope) => !GLOBAL_EPOCH_SCOPES.has(scope),
);

const GLOBAL_TENANT = 'global';

const PENDING_BUMPS = '__tenantEpochBumps';

/** After a Redis failure, epochs are neither read nor bumped for this long. */
const REDIS_RETRY_MS = 5_000;

/**
 * One round trip for every key a write touched: a missing counter is created
 * from the clock first (as `readEpoch` does), so an evicted one never
 * restarts at a value an old entry may still be keyed on.
 */
const BUMP_SCRIPT = `
for _, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 0 then redis.call('SET', key, ARGV[1]) end
  redis.call('INCR', key)
end
return #KEYS`;

/** Bumps started for the current request after a commit, awaited before it answers. */
export interface RequestBumps {
  readonly pending: Promise<unknown>[];
}

const requestBumps = new AsyncLocalStorage<RequestBumps>();

interface PendingBump {
  organizationIds: string | null | undefined | ReadonlyArray<string | null | undefined>;
  scopes: TenantEpochScope[];
}

export function tenantEpochKey(scope: TenantEpochScope, organizationId: string | null): string {
  const tenant = GLOBAL_EPOCH_SCOPES.has(scope) ? GLOBAL_TENANT : organizationId;
  return `assay:tenant-epoch:${scope}:${tenant}`;
}

/**
 * Per-organization invalidation counters for the tenant read cache.
 *
 * ## Rules for a writer
 *
 * Bump **after** the write has committed, and await it before answering. A bump
 * before the commit lets a concurrent read cache the pre-write rows under the
 * new epoch, and the writer's own next read would then be served the old data.
 * After the commit, a read that started earlier stores its result under the
 * old epoch, which nobody asks for any more.
 *
 * A bump never throws: the write it follows has already happened, and a Redis
 * that cannot be reached must not turn a committed write into an error. The
 * cache's TTL bounds the staleness then (5 s or less for money).
 *
 * A missing counter is created from the clock (`readEpoch`), never read as a
 * constant, so an evicted counter cannot make old entries match again.
 */
@Injectable()
export class TenantEpochService {
  private readonly logger = new Logger(TenantEpochService.name);

  private skipUntil = Number.NEGATIVE_INFINITY;

  constructor(private readonly cache: CacheService) {}

  /**
   * Run `work` (a request's handler) so that bumps fired after its commits are
   * collected in `bumps`; {@link settleRequestBumps} then awaits them before
   * the response leaves. A commit hook never awaits a bump itself, so the
   * bump does not hold the transaction's connection.
   */
  trackRequestBumps<T>(bumps: RequestBumps, work: () => T): T {
    return requestBumps.run(bumps, work);
  }

  /** Await every bump the request fired after a commit. */
  async settleRequestBumps(bumps: RequestBumps): Promise<void> {
    while (bumps.pending.length > 0) {
      await Promise.all(bumps.pending.splice(0));
    }
  }

  private unavailable(): boolean {
    return Date.now() < this.skipUntil;
  }

  private failed(what: string, error: unknown): void {
    this.skipUntil = Date.now() + REDIS_RETRY_MS;
    this.logger.warn(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }

  /**
   * The current value of each scope, in order, or `null` when any cannot be
   * read — the caller then does not cache. One `MGET` for the usual case.
   */
  async read(
    organizationId: string | null,
    scopes: readonly TenantEpochScope[],
  ): Promise<string[] | null> {
    if (scopes.length === 0) return [];
    const keys = scopes.map((scope) => this.keyOrNull(scope, organizationId));
    if (keys.some((key) => key === null)) return null;
    if (this.unavailable()) return null;
    try {
      const redis = this.cache.getRedisClient();
      const values = await withRedisTimeout(() => redis.mget(...(keys as string[])));
      return await Promise.all(
        values.map((value, i) =>
          value !== null ? value : withRedisTimeout(() => readEpoch(redis, keys[i] as string)),
        ),
      );
    } catch (error) {
      this.failed('tenant epochs unreadable, not caching', error);
      return null;
    }
  }

  /**
   * Bump `scopes` for each organization (a global scope once). Duplicates and
   * nullish ids are dropped, so a caller can pass every party a write touched.
   */
  async bump(
    organizationIds: string | null | undefined | ReadonlyArray<string | null | undefined>,
    ...scopes: TenantEpochScope[]
  ): Promise<void> {
    const orgs = [
      ...new Set(
        (Array.isArray(organizationIds) ? organizationIds : [organizationIds]).filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
      ),
    ];
    const keys = new Set<string>();
    for (const scope of new Set(scopes)) {
      if (GLOBAL_EPOCH_SCOPES.has(scope)) {
        keys.add(tenantEpochKey(scope, null));
        continue;
      }
      for (const org of orgs) keys.add(tenantEpochKey(scope, org));
    }
    if (keys.size === 0) return;
    if (this.unavailable()) {
      // Redis failed a moment ago: no deadline per write during an outage.
      this.logger.debug(`${keys.size} epoch(s) not bumped: Redis unavailable`);
      return;
    }
    const redis = this.cache.getRedisClient();
    const start = (BigInt(Date.now()) * 1_000_000n + BigInt(randomInt(1_000_000))).toString();
    try {
      await withRedisTimeout(() => redis.eval(BUMP_SCRIPT, keys.size, ...keys, start));
    } catch (error) {
      this.failed(`${[...keys].join(', ')} not bumped; cached reads last until their TTL`, error);
    }
  }

  /**
   * Bump once the transaction `on` belongs to has committed; now, when it is
   * not in a transaction (an autocommitted write has already committed).
   *
   * For a write made deep inside a caller's transaction — the ledger journal,
   * a payment-intent transition — where the code that writes does not own the
   * commit. The bump starts from TypeORM's `AfterTransactionCommit` of the
   * outermost transaction, without holding the connection for it; inside a
   * request, `TenantWriteEpochInterceptor` awaits it before the response
   * leaves (`settleRequestBumps`). A rollback drops it.
   */
  async bumpAfterCommit(
    on: QueryRunner | EntityManager | null | undefined,
    organizationIds: string | null | undefined | ReadonlyArray<string | null | undefined>,
    ...scopes: TenantEpochScope[]
  ): Promise<void> {
    const queryRunner = (on as EntityManager | null)?.queryRunner ?? (on as QueryRunner | null);
    if (!queryRunner || !queryRunner.isTransactionActive || !queryRunner.connection) {
      await this.bump(organizationIds, ...scopes);
      return;
    }
    this.ensureSubscribed(queryRunner.connection);
    const data = (queryRunner.data ??= {}) as { [PENDING_BUMPS]?: PendingBump[] };
    (data[PENDING_BUMPS] ??= []).push({ organizationIds, scopes });
  }

  private readonly subscribed = new WeakSet<DataSource>();

  private ensureSubscribed(dataSource: DataSource): void {
    if (this.subscribed.has(dataSource)) return;
    this.subscribed.add(dataSource);
    const flush = async (queryRunner: QueryRunner, commit: boolean) => {
      // A savepoint released or rolled back inside an outer transaction is
      // not the commit; wait for the outermost one.
      if (queryRunner.isTransactionActive) return;
      const data = queryRunner.data as { [PENDING_BUMPS]?: PendingBump[] } | undefined;
      const pending = data?.[PENDING_BUMPS];
      if (!pending?.length) return;
      delete data![PENDING_BUMPS];
      if (!commit) return;
      // Not awaited here: `commitTransaction` awaits this hook, and the
      // connection would stay checked out for a Redis round trip. The
      // request awaits it instead (`settleRequestBumps`) before answering;
      // a worker's bump simply completes on its own.
      const bumps = Promise.all(pending.map((p) => this.bump(p.organizationIds, ...p.scopes)));
      requestBumps.getStore()?.pending.push(bumps);
    };
    const subscriber: EntitySubscriberInterface = {
      afterTransactionCommit: (event) => flush(event.queryRunner, true),
      afterTransactionRollback: (event) => flush(event.queryRunner, false),
    };
    dataSource.subscribers.push(subscriber);
  }

  /** Bump the global operator scope. */
  async bumpOperator(): Promise<void> {
    await this.bump(null, 'operator');
  }

  private keyOrNull(scope: TenantEpochScope, organizationId: string | null): string | null {
    if (!GLOBAL_EPOCH_SCOPES.has(scope) && !organizationId) return null;
    return tenantEpochKey(scope, organizationId);
  }
}
