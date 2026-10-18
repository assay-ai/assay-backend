import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';

import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import {
  OAUTH_CLEANUP_ACCESS_TOKEN_RETENTION_MS,
  OAUTH_CLEANUP_BATCH_SIZE,
  OAUTH_CLEANUP_CIMD_CACHE_GRACE_MS,
  OAUTH_CLEANUP_CLIENT_MIN_AGE_MS,
  OAUTH_CLEANUP_CODE_RETENTION_MS,
  OAUTH_CLEANUP_CONFIG,
  OAUTH_CLEANUP_LOCK_KEY,
  OAUTH_CLEANUP_LOCK_TTL_SECONDS,
  OAUTH_CLEANUP_REFRESH_TOKEN_RETENTION_MS,
  OAUTH_CLEANUP_TIME_BUDGET_MS,
} from '../constants/oauth-cleanup.constants';

export { OAUTH_CLEANUP_LOCK_KEY };

export interface OAuthCleanupConfig {
  now: () => number;
  /**
   * `OAUTH_VERIFIED_CLIENTS` ids, never deleted. `null` when the variable
   * could not be read: then no client is deleted at all.
   */
  verifiedClientIds: readonly string[] | null;
}

export type OAuthCleanupSummary =
  | { skipped: true }
  | {
      skipped: false;
      accessTokens: number;
      refreshTokens: number;
      codes: number;
      clients: number;
    };

/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

const DELETABLE_CLIENT_KINDS = [OAuthClientKind.DCR, OAuthClientKind.CIMD];

/**
 * Every condition a client must meet to be deleted. Used by the candidate
 * query and again by each one-row delete, so a client that changed between
 * the two is kept. `$1` kinds, `$2` the 30-day cutoff, `$3` verified client
 * ids, `$4` the CIMD cache cutoff (now − 1 h).
 *
 * A client is stale when it was created over 30 days ago and neither used
 * nor (CIMD) fetched since the cutoff. A CIMD row is also stale once its
 * `cache_until` is over an hour past: it is only a cache of a document the
 * registry fetches again on the next authorize, and the hour outlives any
 * pending request that resolved it.
 */
const DELETABLE_CLIENT_WHERE = `
      c."kind" = ANY($1)
  AND (
        (c."created_at" < $2
         AND (c."last_used_at" IS NULL OR c."last_used_at" < $2)
         AND (c."kind" <> '${OAuthClientKind.CIMD}' OR c."fetched_at" IS NULL OR c."fetched_at" < $2))
     OR (c."kind" = '${OAuthClientKind.CIMD}' AND c."cache_until" < $4)
      )
  AND NOT (c."client_id" = ANY($3))
  AND NOT EXISTS (SELECT 1 FROM "agent_credentials" a WHERE a."oauth_client_id" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "oauth_authorization_codes" k WHERE k."oauth_client_id" = c."id")`;

/**
 * The OAuth cleanup (spec §6.2, IM-6), run daily by `OAuthCleanupJob` in the
 * scheduler only.
 *
 * - Access tokens and refresh tokens 30 days past expiry, and codes 1 day
 *   past expiry, are deleted. Access tokens are kept as long as refresh
 *   tokens so the stale-reuse check (§6.3.11, R-OA-15) still finds the
 *   `first_used_at` of a chain's access tokens while a used refresh token
 *   can be presented. A refresh token 30 days past expiry is refused
 *   whatever its state, and its grant cannot be revived, so it goes too.
 * - A DCR or CIMD client is deleted only when no `agent_credentials` row (in
 *   any state, soft-deleted included) and no code row references it, and it
 *   is stale: created over 30 days ago and neither used nor (CIMD) fetched
 *   in the last 30 days, or (CIMD) over an hour past its `cache_until`.
 *   `BUILTIN` and `OAUTH_VERIFIED_CLIENTS` rows are never deleted. The FK `RESTRICT` backs this: a client that gains a reference
 *   mid-run refuses its delete and is kept.
 * - **Invariant this relies on:** `oauth_refresh_tokens.oauth_client_id` has
 *   no FK, and it needs none only because every refresh row belongs to a
 *   credential row on the same client, and credential rows are never
 *   deleted. A change that allows a refresh row without such a credential
 *   (or deletes credential rows) must add a reference check here, or tokens
 *   would be orphaned silently.
 * - Credential rows are never deleted: a grant stays an `agent_credentials`
 *   row for its audit trail, like an API key.
 *
 * These are platform-wide deletes by expiry, not reads of one tenant's data,
 * so they run on the data source rather than the tenant-guarded repositories.
 * Each statement is bounded (`LIMIT` batches). The client pass loops over
 * batches for up to 45 minutes from the start of the run, inside the lock's
 * hour; a backlog beyond that is left for the next day.
 *
 * `SET oauth:cleanup:lock 1 NX EX 3600` makes a second run inside the hour,
 * from this replica or another, a no-op. Without Redis the run is skipped:
 * the next day's run catches up, and every delete is idempotent.
 *
 * `assay_oauth_live_grants_per_agent` is not set here: the API app's
 * `MetricsCollectorService` sets it, where `/metrics` is served.
 */
@Injectable()
export class OAuthCleanupService {
  private readonly logger = new Logger(OAuthCleanupService.name);

  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Optional() @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis | null,
    @Inject(OAUTH_CLEANUP_CONFIG) private readonly config: OAuthCleanupConfig,
  ) {}

  async run(): Promise<OAuthCleanupSummary> {
    if (!(await this.takeLock())) return { skipped: true };

    const now = this.config.now();
    const codes = await this.deleteInBatches(
      'oauth_authorization_codes',
      new Date(now - OAUTH_CLEANUP_CODE_RETENTION_MS),
    );
    const accessTokens = await this.deleteInBatches(
      'oauth_access_tokens',
      new Date(now - OAUTH_CLEANUP_ACCESS_TOKEN_RETENTION_MS),
    );
    const refreshTokens = await this.deleteInBatches(
      'oauth_refresh_tokens',
      new Date(now - OAUTH_CLEANUP_REFRESH_TOKEN_RETENTION_MS),
    );
    // After the codes, so a client held only by dead codes goes in this run.
    const clients = await this.deleteUnreferencedClients(
      new Date(now - OAUTH_CLEANUP_CLIENT_MIN_AGE_MS),
      new Date(now - OAUTH_CLEANUP_CIMD_CACHE_GRACE_MS),
      now + OAUTH_CLEANUP_TIME_BUDGET_MS,
    );

    return { skipped: false, accessTokens, refreshTokens, codes, clients };
  }

  private async takeLock(): Promise<boolean> {
    if (!this.redis) {
      this.logger.warn('OAuth cleanup skipped: no Redis for the job lock');
      return false;
    }
    try {
      const taken = await this.redis.set(
        OAUTH_CLEANUP_LOCK_KEY,
        '1',
        'EX',
        OAUTH_CLEANUP_LOCK_TTL_SECONDS,
        'NX',
      );
      return taken === 'OK';
    } catch (error) {
      this.logger.warn(
        `OAuth cleanup skipped: the job lock could not be taken ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
      return false;
    }
  }

  /** Deletes rows of `table` (a constant of this class) whose `expires_at` is before the cutoff. */
  private async deleteInBatches(table: string, cutoff: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const [, deleted] = (await this.dataSource.query(
        `DELETE FROM "${table}" WHERE "id" IN ` +
          `(SELECT "id" FROM "${table}" WHERE "expires_at" < $1 LIMIT $2)`,
        [cutoff, OAUTH_CLEANUP_BATCH_SIZE],
      )) as [unknown, number];
      total += deleted;
      if (deleted < OAUTH_CLEANUP_BATCH_SIZE) return total;
    }
  }

  /**
   * Batches of candidates, oldest first, until a batch comes back short or
   * the time budget (`deadline`, on the config clock) is spent; what is left
   * goes the next day. Each client is deleted in its own statement: one that
   * gains a reference mid-run fails only its own delete (FK RESTRICT).
   */
  private async deleteUnreferencedClients(
    cutoff: Date,
    cacheCutoff: Date,
    deadline: number,
  ): Promise<number> {
    const verified = this.config.verifiedClientIds;
    if (verified === null) {
      this.logger.warn('OAuth cleanup deletes no client: OAUTH_VERIFIED_CLIENTS could not be read');
      return 0;
    }
    const params = [DELETABLE_CLIENT_KINDS, cutoff, [...verified], cacheCutoff];

    let deleted = 0;
    for (;;) {
      if (this.config.now() >= deadline) {
        this.logger.warn(
          `OAuth cleanup stopped the client pass at its time budget after ${deleted} ` +
            'deletes; the rest goes on the next run',
        );
        return deleted;
      }
      const candidates = (await this.dataSource.query(
        `SELECT c."id" FROM "oauth_clients" c WHERE ${DELETABLE_CLIENT_WHERE}
          ORDER BY c."created_at" LIMIT $5`,
        [...params, OAUTH_CLEANUP_BATCH_SIZE],
      )) as { id: string }[];

      let deletedInBatch = 0;
      for (const { id } of candidates) {
        try {
          const [, count] = (await this.dataSource.query(
            `DELETE FROM "oauth_clients" c WHERE c."id" = $5 AND ${DELETABLE_CLIENT_WHERE}`,
            [...params, id],
          )) as [unknown, number];
          deletedInBatch += count;
        } catch (error) {
          if ((error as { code?: string }).code !== FOREIGN_KEY_VIOLATION) throw error;
        }
      }
      deleted += deletedInBatch;
      // A short batch is the last one. A full batch that deleted nothing
      // would be fetched again unchanged, so it ends the pass too.
      if (candidates.length < OAUTH_CLEANUP_BATCH_SIZE || deletedInBatch === 0) return deleted;
    }
  }
}
