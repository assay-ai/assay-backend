import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, IsNull } from 'typeorm';

import { ModerationCutoffEntity } from '../entities/moderation-cutoff.entity';
import { OrgHandleClaimEntity } from '../entities/org-handle-claim.entity';
import { OrgHandleHistoryEntity } from '../entities/org-handle-history.entity';
import { ToolsetReportEntity } from '../entities/toolset-report.entity';
import {
  ToolsetNoticeLogEntity,
  ToolsetStatsDailyEntity,
  ToolsetStatsPublishedEntity,
} from '../entities/toolset-stats.entity';
import { ToolsetVersionEntity } from '../entities/toolset-version.entity';
import { AbstractRepository } from './abstract.repository';

/**
 * The T2 publishing tables (design spec §7.2). Not organization-scoped: a
 * published version, a handle or a weekly figure is read across tenants by
 * construction, so every service names whose row it means explicitly.
 */
@Injectable()
export class ToolsetVersionRepository extends AbstractRepository<ToolsetVersionEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ToolsetVersionEntity, dataSource);
  }

  findVersion(toolsetId: string, version: number): Promise<ToolsetVersionEntity | null> {
    return this.findOne({ where: { toolsetId, version } });
  }

  /** Newest first. */
  listVersions(toolsetId: string): Promise<ToolsetVersionEntity[]> {
    return this.find({ where: { toolsetId }, order: { version: 'DESC' } });
  }

  /** Exactly the `(toolset, version)` pairs asked for that exist. */
  async findPairs(
    pairs: readonly { toolsetId: string; version: number }[],
  ): Promise<ToolsetVersionEntity[]> {
    if (pairs.length === 0) return [];
    const ids = [...new Set(pairs.map((pair) => pair.toolsetId))];
    const rows = await this.find({ where: { toolsetId: In(ids) } });
    const wanted = new Set(pairs.map((pair) => `${pair.toolsetId}@${pair.version}`));
    return rows.filter((row) => wanted.has(`${row.toolsetId}@${row.version}`));
  }

  async countPublishedSince(toolsetId: string, since: Date): Promise<number> {
    return this.createQueryBuilder('v')
      .where('v.toolset_id = :toolsetId', { toolsetId })
      .andWhere('v.published_at >= :since', { since })
      .getCount();
  }
}

@Injectable()
export class OrgHandleHistoryRepository extends AbstractRepository<OrgHandleHistoryEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(OrgHandleHistoryEntity, dataSource);
  }

  /** The row holding `handle` (an alias or a held old handle), if any. */
  findHeld(handle: string): Promise<OrgHandleHistoryEntity | null> {
    return this.findOne({ where: { oldHandle: handle, reassignedAt: IsNull() } });
  }
}

@Injectable()
export class OrgHandleClaimRepository extends AbstractRepository<OrgHandleClaimEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(OrgHandleClaimEntity, dataSource);
  }

  /** Organizations `privyUserId` claimed or changed a handle for since `since`. */
  async recentOrgIds(privyUserId: string, since: Date): Promise<string[]> {
    const rows = await this.createQueryBuilder('c')
      .select('DISTINCT c.org_id', 'orgId')
      .where('c.privy_user_id = :privyUserId', { privyUserId })
      .andWhere('c.claimed_at >= :since', { since })
      .getRawMany<{ orgId: string }>();
    return rows.map((row) => row.orgId);
  }
}

@Injectable()
export class ToolsetReportRepository extends AbstractRepository<ToolsetReportEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ToolsetReportEntity, dataSource);
  }
}

@Injectable()
export class ModerationCutoffRepository extends AbstractRepository<ModerationCutoffEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ModerationCutoffEntity, dataSource);
  }

  /** Cutoffs nobody confirmed in time and nobody reverted yet. */
  findDue(now: Date): Promise<ModerationCutoffEntity[]> {
    return this.createQueryBuilder('c')
      .where('c.confirmed_at IS NULL')
      .andWhere('c.reverted_at IS NULL')
      .andWhere('c.confirm_by <= :now', { now })
      .orderBy('c.confirm_by', 'ASC')
      .take(500)
      .getMany();
  }
}

@Injectable()
export class ToolsetStatsRepository extends AbstractRepository<ToolsetStatsPublishedEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ToolsetStatsPublishedEntity, dataSource);
  }

  /** The latest published week of each toolset in `toolsetIds`. */
  async latestFor(
    toolsetIds: readonly string[],
  ): Promise<Map<string, ToolsetStatsPublishedEntity>> {
    if (toolsetIds.length === 0) return new Map();
    const rows = await this.createQueryBuilder('s')
      .distinctOn(['s.toolset_id'])
      .where('s.toolset_id IN (:...ids)', { ids: [...toolsetIds] })
      .orderBy('s.toolset_id')
      .addOrderBy('s.week_start', 'DESC')
      .getMany();
    return new Map(rows.map((row) => [row.toolsetId, row]));
  }
}

export const TOOLSET_SHARING_ENTITIES = [
  ToolsetVersionEntity,
  OrgHandleHistoryEntity,
  OrgHandleClaimEntity,
  ToolsetReportEntity,
  ToolsetNoticeLogEntity,
  ToolsetStatsDailyEntity,
  ToolsetStatsPublishedEntity,
  ModerationCutoffEntity,
];

export const TOOLSET_SHARING_REPOSITORIES = [
  ToolsetVersionRepository,
  OrgHandleHistoryRepository,
  OrgHandleClaimRepository,
  ToolsetReportRepository,
  ModerationCutoffRepository,
  ToolsetStatsRepository,
];
