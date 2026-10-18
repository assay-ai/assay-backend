import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';

import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import {
  OAUTH_CLEANUP_ACCESS_TOKEN_RETENTION_MS,
  OAUTH_CLEANUP_BATCH_SIZE,
  OAUTH_CLEANUP_CLIENT_MIN_AGE_MS,
  OAUTH_CLEANUP_CODE_RETENTION_MS,
  OAUTH_CLEANUP_CONFIG,
  OAUTH_CLEANUP_LOCK_KEY,
  OAUTH_CLEANUP_LOCK_TTL_SECONDS,
  OAUTH_CLEANUP_REFRESH_TOKEN_RETENTION_MS,
} from '../constants/oauth-cleanup.constants';
import { OAuthMetrics } from './oauth-metrics.service';

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
      maxLiveGrantsPerAgent: number;
    };

/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * The OAuth cleanup (spec §6.2, IM-6), run daily by `OAuthCleanupJob` in the
 * scheduler only.
 *
 * - Access tokens 7 days past expiry, used or revoked refresh tokens 30 days
 *   past expiry, and codes 1 day past expiry are deleted.
 * - A DCR or CIMD client is deleted only when no `agent_credentials` row (in
 *   any state, soft-deleted included) and no code row references it, and it
 *   is older than 30 days and unused for 30 days. `BUILTIN` and
 *   `OAUTH_VERIFIED_CLIENTS` rows are never deleted. The FK `RESTRICT` backs
 *   this: a client that gains a reference mid-run refuses the delete and is
 *   kept.
 * - Credential rows are never deleted: a grant stays an `agent_credentials`
 *   row for its audit trail, like an API key.
 * - `assay_oauth_live_grants_per_agent` is set to the largest number of live
 *   grants any one agent holds.
 *
 * These are platform-wide deletes by expiry, not reads of one tenant's data,
 * so they run on the data source rather than the tenant-guarded repositories.
 *
 * `SET oauth:cleanup:lock 1 NX EX 3600` makes a second run inside the hour,
 * from this replica or another, a no-op. Without Redis the run is skipped:
 * the next day's run catches up, and every delete is idempotent.
 */
@Injectable()
export class OAuthCleanupService {
  private readonly logger = new Logger(OAuthCleanupService.name);

  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Optional() @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis | null,
    private readonly metrics: OAuthMetrics,
    @Inject(OAUTH_CLEANUP_CONFIG) private readonly config: OAuthCleanupConfig,
  ) {}

  async run(): Promise<OAuthCleanupSummary> {
    if (!(await this.takeLock())) return { skipped: true };

    const now = this.config.now();
    const codes = await this.deleteInBatches('oauth_authorization_codes', `"expires_at" < $1`, [
      new Date(now - OAUTH_CLEANUP_CODE_RETENTION_MS),
    ]);
    const accessTokens = await this.deleteInBatches('oauth_access_tokens', `"expires_at" < $1`, [
      new Date(now - OAUTH_CLEANUP_ACCESS_TOKEN_RETENTION_MS),
    ]);
    const refreshTokens = await this.deleteInBatches(
      'oauth_refresh_tokens',
      `"expires_at" < $1 AND ("used_at" IS NOT NULL OR "revoked_at" IS NOT NULL)`,
      [new Date(now - OAUTH_CLEANUP_REFRESH_TOKEN_RETENTION_MS)],
    );
    // After the codes, so a client held only by dead codes goes in this run.
    const clients = await this.deleteUnreferencedClients(
      new Date(now - OAUTH_CLEANUP_CLIENT_MIN_AGE_MS),
    );
    const maxLiveGrantsPerAgent = await this.maxLiveGrantsPerAgent(new Date(now));
    this.metrics.setLiveGrantsPerAgentMax(maxLiveGrantsPerAgent);

    return {
      skipped: false,
      accessTokens,
      refreshTokens,
      codes,
      clients,
      maxLiveGrantsPerAgent,
    };
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

  /** `table` and `where` are constants of this class, never input. */
  private async deleteInBatches(table: string, where: string, params: unknown[]): Promise<number> {
    const limit = `$${params.length + 1}`;
    let total = 0;
    for (;;) {
      const [, deleted] = (await this.dataSource.query(
        `DELETE FROM "${table}" WHERE "id" IN ` +
          `(SELECT "id" FROM "${table}" WHERE ${where} LIMIT ${limit})`,
        [...params, OAUTH_CLEANUP_BATCH_SIZE],
      )) as [unknown, number];
      total += deleted;
      if (deleted < OAUTH_CLEANUP_BATCH_SIZE) return total;
    }
  }

  private async deleteUnreferencedClients(cutoff: Date): Promise<number> {
    const verified = this.config.verifiedClientIds;
    if (verified === null) {
      this.logger.warn('OAuth cleanup deletes no client: OAUTH_VERIFIED_CLIENTS could not be read');
      return 0;
    }

    const candidates = (await this.dataSource.query(
      `SELECT c."id" FROM "oauth_clients" c
        WHERE c."kind" = ANY($1)
          AND c."created_at" < $2
          AND (c."last_used_at" IS NULL OR c."last_used_at" < $2)
          AND NOT (c."client_id" = ANY($3))
          AND NOT EXISTS (SELECT 1 FROM "agent_credentials" a WHERE a."oauth_client_id" = c."id")
          AND NOT EXISTS (SELECT 1 FROM "oauth_authorization_codes" k WHERE k."oauth_client_id" = c."id")`,
      [[OAuthClientKind.DCR, OAuthClientKind.CIMD], cutoff, [...verified]],
    )) as { id: string }[];

    // One statement per client: a client that gains a reference mid-run
    // fails only its own delete (FK RESTRICT), not the whole sweep.
    let deleted = 0;
    for (const { id } of candidates) {
      try {
        const [, count] = (await this.dataSource.query(
          `DELETE FROM "oauth_clients" c
            WHERE c."id" = $1
              AND c."kind" = ANY($2)
              AND NOT (c."client_id" = ANY($3))
              AND NOT EXISTS (SELECT 1 FROM "agent_credentials" a WHERE a."oauth_client_id" = c."id")
              AND NOT EXISTS (SELECT 1 FROM "oauth_authorization_codes" k WHERE k."oauth_client_id" = c."id")`,
          [id, [OAuthClientKind.DCR, OAuthClientKind.CIMD], [...verified]],
        )) as [unknown, number];
        deleted += count;
      } catch (error) {
        if ((error as { code?: string }).code !== FOREIGN_KEY_VIOLATION) throw error;
      }
    }
    return deleted;
  }

  /**
   * The same "live" as `AgentCredentialRepository.countLiveOAuthForAgent`
   * (not revoked, not expired, not soft-deleted), as one aggregate over every
   * agent. An agent is `(organization_id, agent_id)`.
   */
  private async maxLiveGrantsPerAgent(now: Date): Promise<number> {
    const [row] = (await this.dataSource.query(
      `SELECT COALESCE(MAX(live."count"), 0)::int AS "max"
         FROM (SELECT count(*) AS "count"
                 FROM "agent_credentials"
                WHERE "issued_via" = 'OAUTH'
                  AND "revoked_at" IS NULL
                  AND "deleted_at" IS NULL
                  AND ("expires_at" IS NULL OR "expires_at" > $1)
                GROUP BY "organization_id", "agent_id") live`,
      [now],
    )) as { max: number }[];
    return row.max;
  }
}
