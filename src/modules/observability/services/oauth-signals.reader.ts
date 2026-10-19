import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CredentialIssuedVia } from '@database/postgres/entities/agent-credential.entity';
import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';
import {
  OAUTH_REVOKED_BY_CODE_REUSED,
  OAUTH_REVOKED_BY_REFRESH_REUSE,
} from '@modules/oauth/constants/oauth.constants';
import {
  OAUTH_COUNTER_HOUR_MS,
  OAUTH_COUNTERS,
  OAuthCounterName,
  oauthCounterKey,
} from '@modules/oauth/domain/oauth-counters';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

/** The OAuth facts the database already holds (spec §6.7). Windows are the trailing 24 h. */
export interface OAuthDatabaseFacts {
  /** Live OAuth credentials (grants), all agents. */
  liveGrants: number;
  /** The most live grants one agent holds, against the cap of 50. */
  maxLiveGrantsPerAgent: number;
  /** Grants revoked because a rotated refresh token came back (`revoked_by`). */
  stoppedForRefreshReuse: number;
  /** Grants revoked because their code was presented twice (`revoked_by`). */
  stoppedForCodeReuse: number;
  /** Audit `oauth.refresh_stale_reuse`: a rotated token came back, nothing was stopped. */
  refreshStaleReuse: number;
  /** Audit `oauth.refresh_grace_used`. */
  refreshGraceUses: number;
  /** `oauth_clients` rows of kind DCR created. */
  dcrRegistrations: number;
  /** The most DCR rows created under one `client_name`. */
  dcrMaxPerClientName: number;
  /** `oauth_clients` rows of kind CIMD (all time: the rows are kept while in use). */
  cimdClients: number;
}

/** The request-path counters `OAuthMetrics` writes, summed per label. */
export interface OAuthCounterFigures {
  /** The last 24 hourly buckets, the current one included. */
  last24h: Record<OAuthCounterName, Record<string, number>>;
  /**
   * The trailing hour, estimated from two buckets: the current one, plus the
   * previous one weighted by the part of it still inside the hour.
   */
  lastHour: { consentApproved: number; continueCookieMissing: number };
}

export interface OAuthSignalFigures {
  /** `null` when the read failed. */
  database: OAuthDatabaseFacts | null;
  /** `null` when Redis could not be read. */
  counters: OAuthCounterFigures | null;
}

export const OAUTH_SIGNAL_WINDOW_MS = 24 * OAUTH_COUNTER_HOUR_MS;

/**
 * Reads the OAuth signals behind the operator dashboard: database facts where
 * a fact is stored, Redis hourly counters for counts that exist only on the
 * request path. A failed source reads as `null`, so the dashboard shows the
 * signal absent rather than failing the other rows.
 *
 * Cross-tenant on purpose, like `ObservabilityMetricsRepository`. Called at
 * most once per collector cache TTL.
 */
@Injectable()
export class OAuthSignalsReader {
  private readonly logger = new Logger(OAuthSignalsReader.name);

  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    private readonly cache: CacheService,
  ) {}

  async read(nowMs: number): Promise<OAuthSignalFigures> {
    const [database, counters] = await Promise.all([
      this.databaseFacts(new Date(nowMs - OAUTH_SIGNAL_WINDOW_MS)).catch((error: unknown) => {
        this.logger.warn(`OAuth signals: database read failed: ${describe(error)}`);
        return null;
      }),
      this.counterFigures(nowMs).catch((error: unknown) => {
        this.logger.warn(`OAuth signals: counter read failed: ${describe(error)}`);
        return null;
      }),
    ]);
    return { database, counters };
  }

  async databaseFacts(since: Date): Promise<OAuthDatabaseFacts> {
    const live = `"issued_via" = $1 AND "revoked_at" IS NULL AND "deleted_at" IS NULL
                  AND ("expires_at" IS NULL OR "expires_at" > now())`;
    const [row] = (await this.dataSource.query(
      `SELECT
         (SELECT count(*) FROM "agent_credentials" WHERE ${live})::int AS "liveGrants",
         (SELECT COALESCE(MAX(g."count"), 0) FROM
            (SELECT count(*) AS "count" FROM "agent_credentials" WHERE ${live}
              GROUP BY "organization_id", "agent_id") g)::int AS "maxLiveGrantsPerAgent",
         (SELECT count(*) FROM "agent_credentials"
           WHERE "revoked_by" = $3 AND "revoked_at" >= $2)::int AS "stoppedForRefreshReuse",
         (SELECT count(*) FROM "agent_credentials"
           WHERE "revoked_by" = $4 AND "revoked_at" >= $2)::int AS "stoppedForCodeReuse",
         (SELECT count(*) FROM "audit_log_entries"
           WHERE "action" = 'oauth.refresh_stale_reuse' AND "created_at" >= $2)::int
           AS "refreshStaleReuse",
         (SELECT count(*) FROM "audit_log_entries"
           WHERE "action" = 'oauth.refresh_grace_used' AND "created_at" >= $2)::int
           AS "refreshGraceUses",
         (SELECT count(*) FROM "oauth_clients"
           WHERE "kind" = $5 AND "created_at" >= $2)::int AS "dcrRegistrations",
         (SELECT COALESCE(MAX(n."count"), 0) FROM
            (SELECT count(*) AS "count" FROM "oauth_clients"
              WHERE "kind" = $5 AND "created_at" >= $2 GROUP BY "client_name") n)::int
           AS "dcrMaxPerClientName",
         (SELECT count(*) FROM "oauth_clients" WHERE "kind" = $6)::int AS "cimdClients"`,
      [
        CredentialIssuedVia.OAUTH,
        since,
        OAUTH_REVOKED_BY_REFRESH_REUSE,
        OAUTH_REVOKED_BY_CODE_REUSED,
        OAuthClientKind.DCR,
        OAuthClientKind.CIMD,
      ],
    )) as OAuthDatabaseFacts[];
    return row;
  }

  async counterFigures(nowMs: number): Promise<OAuthCounterFigures> {
    const names = Object.keys(OAUTH_COUNTERS) as OAuthCounterName[];
    const hours = Array.from({ length: 24 }, (_, i) => nowMs - i * OAUTH_COUNTER_HOUR_MS);
    const cells = names.flatMap((name) =>
      OAUTH_COUNTERS[name].flatMap((label) =>
        hours.map((at, age) => ({ name, label, age, key: oauthCounterKey(name, label, at) })),
      ),
    );
    const values = await this.cache.getRedisClient().mget(cells.map((cell) => cell.key));

    const last24h = Object.fromEntries(
      names.map((name) => [name, Object.fromEntries(OAUTH_COUNTERS[name].map((l) => [l, 0]))]),
    ) as Record<OAuthCounterName, Record<string, number>>;
    const recent = new Map<string, number>();
    cells.forEach((cell, index) => {
      const value = Number(values[index] ?? 0) || 0;
      last24h[cell.name][cell.label] += value;
      if (cell.age <= 1) recent.set(`${cell.name}:${cell.label}:${cell.age}`, value);
    });

    const intoHour = (nowMs % OAUTH_COUNTER_HOUR_MS) / OAUTH_COUNTER_HOUR_MS;
    const trailingHour = (label: string): number =>
      (recent.get(`consent:${label}:0`) ?? 0) +
      (recent.get(`consent:${label}:1`) ?? 0) * (1 - intoHour);

    return {
      last24h,
      lastHour: {
        consentApproved: trailingHour('approved'),
        continueCookieMissing: trailingHour('continue_cookie_missing'),
      },
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
