import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  RawToolCell,
  RawVersionCell,
  RawWindow,
  dashboardFigures,
  independentParties,
  popularScore,
  publicFigures,
  trendingScore,
} from '../domain/stats';
import { TOOLSET_CLOCK, ToolsetClock, systemClock } from './toolset-clock';

const DAY_MS = 24 * 60 * 60 * 1000;
export const STATS_WINDOW_DAYS = 30;

interface CallGroup {
  readonly orgId: string;
  readonly agentId: string;
  readonly toolId: string | null;
  readonly version: number | null;
  readonly calls: number;
  readonly errors: number;
  readonly notCharged: number;
  readonly real: number;
  readonly firstAt: Date;
  readonly lastAt: Date;
}

interface StatsToolset {
  readonly id: string;
  readonly ownerOrgId: string | null;
  /** The latest version for "On latest": the `/@…` page's, else the link's. */
  readonly lastSharedVersion: number | null;
}

/**
 * Toolset usage statistics (design spec §7.8): a nightly job fills
 * `toolset_stats_daily` (internal, raw), and a weekly job on Monday 00:00 UTC
 * publishes the 30-day window ending on the Sunday into
 * `toolset_stats_published`, already rounded and k-checked. Pages and
 * dashboards read only the weekly table, so figures move once a week and
 * daily windows cannot be differenced.
 *
 * ```text
 * real calls       paid intents that SETTLED, free calls with a data result (no refusal)
 * excluded orgs    the publisher's org, and orgs linked to it: a shared Privy
 *                  user, wallet (agent account) or funding account
 * sybil discount   orgs sharing any of those identities count once
 * retained         orgs active in this window and the one before
 * ```
 *
 * Free-call records are kept 30 days, so the previous window's free-only
 * callers are mostly gone by the time retention is measured; retention
 * therefore leans on paid calls, which is the conservative direction.
 */
@Injectable()
export class ToolsetStatsService {
  private readonly logger = new Logger(ToolsetStatsService.name);

  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Optional() @Inject(TOOLSET_CLOCK) private readonly now: ToolsetClock = systemClock,
  ) {}

  /** Nightly: the window ending yesterday (UTC), for every toolset ever shared. */
  async runDaily(): Promise<number> {
    const day = utcDay(new Date(this.now().getTime() - DAY_MS));
    let count = 0;
    for (const toolset of await this.statsToolsets()) {
      await this.computeDaily(toolset, day);
      count += 1;
    }
    this.logger.log(`toolset stats: ${count} daily rows for ${isoDay(day)}`);
    return count;
  }

  /** Weekly (Monday): the window ending on the Sunday before, published. */
  async runWeekly(): Promise<number> {
    const weekStart = mondayOf(this.now());
    const sunday = new Date(weekStart.getTime() - DAY_MS);
    let count = 0;
    for (const toolset of await this.statsToolsets()) {
      await this.publishWeek(toolset, weekStart, sunday);
      count += 1;
    }
    this.logger.log(`toolset stats: ${count} toolsets published for week ${isoDay(weekStart)}`);
    return count;
  }

  async publishWeek(toolset: StatsToolset, weekStart: Date, windowEnd: Date): Promise<void> {
    const current = await this.computeDaily(toolset, windowEnd);
    const previous =
      (await this.readDaily(
        toolset.id,
        new Date(windowEnd.getTime() - STATS_WINDOW_DAYS * DAY_MS),
      )) ?? null;
    const { tools, versions } = await this.dashboardCells(toolset, windowEnd);
    const figures = publicFigures(current, previous);
    const dashboard = dashboardFigures(tools, versions);
    await this.dataSource.query(
      `INSERT INTO toolset_stats_published
         (toolset_id, week_start, figures, dashboard, popular_score, trending_score, published_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, now())
       ON CONFLICT (toolset_id, week_start) DO UPDATE
         SET figures = EXCLUDED.figures, dashboard = EXCLUDED.dashboard,
             popular_score = EXCLUDED.popular_score, trending_score = EXCLUDED.trending_score,
             published_at = EXCLUDED.published_at`,
      [
        toolset.id,
        isoDay(weekStart),
        JSON.stringify(figures),
        JSON.stringify(dashboard),
        popularScore(current),
        trendingScore(current, previous),
      ],
    );
  }

  /** The raw window ending on `day` (inclusive, UTC), stored in `toolset_stats_daily`. */
  async computeDaily(toolset: StatsToolset, day: Date): Promise<RawWindow> {
    const end = new Date(utcDay(day).getTime() + DAY_MS);
    const start = new Date(end.getTime() - STATS_WINDOW_DAYS * DAY_MS);
    const prevStart = new Date(start.getTime() - STATS_WINDOW_DAYS * DAY_MS);

    const excluded = await this.excludedOrgs(toolset.ownerOrgId);
    const groups = (await this.callGroups(toolset.id, start, end)).filter(
      (group) => !excluded.has(group.orgId) && group.real > 0,
    );
    const previousOrgs = new Set(
      (await this.callGroups(toolset.id, prevStart, start))
        .filter((group) => !excluded.has(group.orgId) && group.real > 0)
        .map((group) => group.orgId),
    );

    const orgs = [...new Set(groups.map((group) => group.orgId))];
    const links = await this.identityLinks(orgs);
    const lastVersionOf = new Map<string, { at: number; version: number | null }>();
    for (const group of groups) {
      const seen = lastVersionOf.get(group.orgId);
      if (!seen || seen.at < group.lastAt.getTime()) {
        lastVersionOf.set(group.orgId, { at: group.lastAt.getTime(), version: group.version });
      }
    }
    const onLatest = orgs.filter(
      (org) =>
        toolset.lastSharedVersion !== null &&
        lastVersionOf.get(org)?.version === toolset.lastSharedVersion,
    );
    const retained = orgs.filter((org) => previousOrgs.has(org));

    const copies = (await this.dataSource.query(
      `SELECT owner_org_id AS "orgId" FROM toolsets
        WHERE forked_from_id = $1 AND created_at >= $2 AND created_at < $3
          AND owner_org_id IS NOT NULL`,
      [toolset.id, start, end],
    )) as { orgId: string }[];
    const copyOrgs = [...new Set(copies.map((row) => row.orgId))].filter(
      (org) => !excluded.has(org),
    );
    const copyLinks = await this.identityLinks(copyOrgs);

    const window: RawWindow = {
      activeOrgs: independentParties(orgs, links),
      activeAgents: new Set(groups.map((group) => group.agentId)).size,
      calls: groups.reduce((sum, group) => sum + group.real, 0),
      copyOrgs: independentParties(copyOrgs, copyLinks),
      latestVersionOrgs: independentParties(onLatest, links),
      retainedOrgs: independentParties(retained, links),
    };
    await this.dataSource.query(
      `INSERT INTO toolset_stats_daily
         (toolset_id, day, active_orgs, active_agents, calls, copies, copy_orgs,
          latest_version_orgs, retained_orgs, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (toolset_id, day) DO UPDATE
         SET active_orgs = EXCLUDED.active_orgs, active_agents = EXCLUDED.active_agents,
             calls = EXCLUDED.calls, copies = EXCLUDED.copies, copy_orgs = EXCLUDED.copy_orgs,
             latest_version_orgs = EXCLUDED.latest_version_orgs,
             retained_orgs = EXCLUDED.retained_orgs, computed_at = EXCLUDED.computed_at`,
      [
        toolset.id,
        isoDay(day),
        window.activeOrgs,
        window.activeAgents,
        window.calls,
        copies.filter((row) => !excluded.has(row.orgId)).length,
        window.copyOrgs,
        window.latestVersionOrgs,
        window.retainedOrgs,
      ],
    );
    return window;
  }

  private async readDaily(toolsetId: string, day: Date): Promise<RawWindow | null> {
    const [row] = (await this.dataSource.query(
      `SELECT active_orgs, active_agents, calls, copy_orgs, latest_version_orgs, retained_orgs
         FROM toolset_stats_daily WHERE toolset_id = $1 AND day = $2`,
      [toolsetId, isoDay(day)],
    )) as Record<string, number>[];
    if (!row) return null;
    return {
      activeOrgs: row.active_orgs,
      activeAgents: row.active_agents,
      calls: row.calls,
      copyOrgs: row.copy_orgs,
      latestVersionOrgs: row.latest_version_orgs,
      retainedOrgs: row.retained_orgs,
    };
  }

  /** Per tool and per version, for the publisher dashboard. */
  private async dashboardCells(
    toolset: StatsToolset,
    windowEnd: Date,
  ): Promise<{ tools: RawToolCell[]; versions: RawVersionCell[] }> {
    const end = new Date(utcDay(windowEnd).getTime() + DAY_MS);
    const start = new Date(end.getTime() - STATS_WINDOW_DAYS * DAY_MS);
    const excluded = await this.excludedOrgs(toolset.ownerOrgId);
    const groups = (await this.callGroups(toolset.id, start, end)).filter(
      (group) => !excluded.has(group.orgId),
    );

    const names = new Map(
      (
        (await this.dataSource.query(`SELECT id, name FROM tools WHERE id = ANY($1::uuid[])`, [
          [...new Set(groups.flatMap((group) => (group.toolId ? [group.toolId] : [])))],
        ])) as { id: string; name: string }[]
      ).map((row) => [row.id, row.name]),
    );
    const byTool = new Map<
      string,
      { orgs: Set<string>; calls: number; errors: number; notCharged: number }
    >();
    for (const group of groups) {
      if (!group.toolId) continue;
      const cell = byTool.get(group.toolId) ?? {
        orgs: new Set<string>(),
        calls: 0,
        errors: 0,
        notCharged: 0,
      };
      cell.orgs.add(group.orgId);
      cell.calls += group.calls;
      cell.errors += group.errors;
      cell.notCharged += group.notCharged;
      byTool.set(group.toolId, cell);
    }
    // Every org count goes through the same sybil discount as the public
    // figures: two accounts of one party never make a cell clear k.
    const links = await this.identityLinks([...new Set(groups.map((group) => group.orgId))]);
    const parties = (orgs: Iterable<string>) => independentParties([...orgs], links);
    const tools: RawToolCell[] = [...byTool.entries()]
      .map(([toolId, cell]) => ({
        toolId,
        toolName: names.get(toolId) ?? '',
        orgs: parties(cell.orgs),
        calls: cell.calls,
        errors: cell.errors,
        notCharged: cell.notCharged,
      }))
      .sort((a, b) => a.toolName.localeCompare(b.toolName));

    // Version adoption: each org counts under the version of its last call;
    // "stopped after an update": called the version before, never called again
    // once this one was published.
    const published = (await this.dataSource.query(
      `SELECT version, published_at AS "publishedAt" FROM toolset_versions
        WHERE toolset_id = $1 ORDER BY version`,
      [toolset.id],
    )) as { version: number; publishedAt: Date }[];
    const lastByOrg = new Map<string, CallGroup>();
    for (const group of groups) {
      const seen = lastByOrg.get(group.orgId);
      if (!seen || seen.lastAt < group.lastAt) lastByOrg.set(group.orgId, group);
    }
    const versions: RawVersionCell[] = published.map(({ version, publishedAt }) => {
      const at = new Date(publishedAt).getTime();
      const onIt = parties(
        [...lastByOrg.values()].filter((group) => group.version === version).map((g) => g.orgId),
      );
      const before = new Set(
        groups
          .filter((group) => group.version === version - 1 && group.firstAt.getTime() < at)
          .map((group) => group.orgId),
      );
      const stopped = parties(
        [...before].filter((org) => (lastByOrg.get(org)?.lastAt.getTime() ?? 0) < at),
      );
      return { version, orgs: onIt, stoppedOrgs: version > 1 ? stopped : 0 };
    });
    return { tools, versions };
  }

  /** Calls through any URL of the toolset, grouped per org, agent, tool and version. */
  private async callGroups(toolsetId: string, start: Date, end: Date): Promise<CallGroup[]> {
    const rows = (await this.dataSource.query(
      `SELECT org_id AS "orgId", agent_id AS "agentId", tool_id AS "toolId",
              toolset_version AS "version",
              count(*)::int AS calls,
              sum(error)::int AS errors,
              sum(not_charged)::int AS "notCharged",
              sum(real)::int AS real,
              min(created_at) AS "firstAt", max(created_at) AS "lastAt"
         FROM (
           SELECT organization_id AS org_id, agent_id, tool_id::text AS tool_id, toolset_version,
                  created_at,
                  CASE WHEN classification IS NOT NULL AND classification <> 'DATA_RESULT'
                       THEN 1 ELSE 0 END AS error,
                  CASE WHEN status IN ('REFUNDED', 'VOIDED') THEN 1 ELSE 0 END AS not_charged,
                  CASE WHEN status = 'SETTLED' THEN 1 ELSE 0 END AS real
             FROM payment_intents
            WHERE toolset_id = $1 AND created_at >= $2 AND created_at < $3
              AND status IN ('SETTLED', 'REFUNDED', 'VOIDED')
           UNION ALL
           SELECT organization_id, agent_id, tool_id, toolset_version, created_at,
                  CASE WHEN classification <> 'DATA_RESULT' THEN 1 ELSE 0 END,
                  0,
                  CASE WHEN classification = 'DATA_RESULT' THEN 1 ELSE 0 END
             FROM tool_call_records
            WHERE toolset_id = $1 AND created_at >= $2 AND created_at < $3
              AND refusal_code IS NULL
         ) calls
        GROUP BY org_id, agent_id, tool_id, toolset_version`,
      [toolsetId, start, end],
    )) as (Omit<CallGroup, 'firstAt' | 'lastAt'> & { firstAt: string; lastAt: string })[];
    return rows.map((row) => ({
      ...row,
      version: row.version === null ? null : Number(row.version),
      firstAt: new Date(row.firstAt),
      lastAt: new Date(row.lastAt),
    }));
  }

  /**
   * The publisher's organization and every organization linked to it: one
   * that shares a Privy user, an agent wallet or a funding account with it.
   */
  async excludedOrgs(ownerOrgId: string | null): Promise<Set<string>> {
    if (ownerOrgId === null) return new Set();
    const identities = await this.identityLinks([ownerOrgId]);
    const keys = [...new Set(identities.map(([, identity]) => identity))];
    const linked = keys.length
      ? ((await this.dataSource.query(
          `${IDENTITY_SQL} SELECT DISTINCT org_id AS "orgId" FROM identities WHERE identity = ANY($1)`,
          [keys],
        )) as { orgId: string }[])
      : [];
    return new Set([ownerOrgId, ...linked.map((row) => row.orgId)]);
  }

  /** `[orgId, identity]` for every Privy user, agent wallet and funding account of `orgIds`. */
  async identityLinks(orgIds: readonly string[]): Promise<[string, string][]> {
    if (orgIds.length === 0) return [];
    const rows = (await this.dataSource.query(
      `${IDENTITY_SQL} SELECT org_id AS "orgId", identity FROM identities WHERE org_id = ANY($1::uuid[])`,
      [[...orgIds]],
    )) as { orgId: string; identity: string }[];
    return rows.map((row) => [row.orgId, row.identity]);
  }

  private async statsToolsets(): Promise<StatsToolset[]> {
    return (await this.dataSource.query(
      // "On latest" means what the `/@…` page calls latest; a toolset that was
      // never public falls back to the newest version its link serves.
      `SELECT id, owner_org_id AS "ownerOrgId",
              COALESCE(last_public_version, last_shared_version) AS "lastSharedVersion"
         FROM toolsets
        WHERE first_shared_at IS NOT NULL OR owner_org_id IS NULL`,
    )) as StatsToolset[];
  }
}

/**
 * Every identity an organization holds, as one CTE: Privy users, and the
 * on-chain accounts it acts or funds from. A wallet and a funding account are
 * the same kind of identity — one key controls both — so they share a prefix.
 */
const IDENTITY_SQL = `
  WITH identities AS (
    SELECT organization_id AS org_id, 'privy:' || privy_user_id AS identity FROM agents
    UNION
    SELECT organization_id, 'account:' || primary_account_id FROM agents
     WHERE primary_account_id IS NOT NULL
    UNION
    SELECT organization_id, 'account:' || agent_account FROM deposit_intents
     WHERE status = 'SETTLED'
    UNION
    SELECT organization_id, 'account:' || account_id FROM buyer_escrows
  )`;

export function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function isoDay(date: Date): string {
  return utcDay(date).toISOString().slice(0, 10);
}

/** The Monday (UTC) of the week `date` falls in. */
export function mondayOf(date: Date): Date {
  const day = utcDay(date);
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * DAY_MS);
}
