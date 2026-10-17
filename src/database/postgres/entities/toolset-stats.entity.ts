import { Column, Entity, PrimaryColumn } from 'typeorm';

/** FR-17 dedupe: one update notice per org, toolset and version. */
@Entity('toolset_notice_log')
export class ToolsetNoticeLogEntity {
  @PrimaryColumn({ name: 'org_id', type: 'uuid' })
  orgId: string;

  @PrimaryColumn({ name: 'toolset_id', type: 'uuid' })
  toolsetId: string;

  @PrimaryColumn({ name: 'to_version', type: 'int' })
  toVersion: number;

  @Column({ name: 'sent_at', type: 'timestamptz' })
  sentAt: Date;
}

/**
 * Raw counts for the rolling 30-day window ending on `day` (UTC). Internal
 * only: nothing outside the weekly job reads it.
 */
@Entity('toolset_stats_daily')
export class ToolsetStatsDailyEntity {
  @PrimaryColumn({ name: 'toolset_id', type: 'uuid' })
  toolsetId: string;

  @PrimaryColumn({ name: 'day', type: 'date' })
  day: string;

  @Column({ name: 'active_orgs', type: 'int' })
  activeOrgs: number;

  @Column({ name: 'active_agents', type: 'int' })
  activeAgents: number;

  @Column({ name: 'calls', type: 'int' })
  calls: number;

  @Column({ name: 'copies', type: 'int' })
  copies: number;

  @Column({ name: 'copy_orgs', type: 'int' })
  copyOrgs: number;

  @Column({ name: 'latest_version_orgs', type: 'int' })
  latestVersionOrgs: number;

  @Column({ name: 'retained_orgs', type: 'int' })
  retainedOrgs: number;

  @Column({ name: 'computed_at', type: 'timestamptz' })
  computedAt: Date;
}

/** What pages and dashboards read: rounded and k-checked, written once a week. */
@Entity('toolset_stats_published')
export class ToolsetStatsPublishedEntity {
  @PrimaryColumn({ name: 'toolset_id', type: 'uuid' })
  toolsetId: string;

  /** The Monday the figures were published (the window ends the Sunday before). */
  @PrimaryColumn({ name: 'week_start', type: 'date' })
  weekStart: string;

  /** `PublicFigures`. */
  @Column({ name: 'figures', type: 'jsonb' })
  figures: Record<string, unknown>;

  /** `DashboardFigures` — the owner's only. */
  @Column({ name: 'dashboard', type: 'jsonb' })
  dashboard: Record<string, unknown>;

  @Column({ name: 'popular_score', type: 'double precision' })
  popularScore: number;

  @Column({ name: 'trending_score', type: 'double precision' })
  trendingScore: number;

  @Column({ name: 'published_at', type: 'timestamptz' })
  publishedAt: Date;
}
