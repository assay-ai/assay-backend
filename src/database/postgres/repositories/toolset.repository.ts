import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, IsNull } from 'typeorm';

import { ToolsetEntryEntity } from '../entities/toolset-entry.entity';
import { ToolsetEntity } from '../entities/toolset.entity';
import { AbstractRepository } from './abstract.repository';

/**
 * `toolsets`. Every read here names its owner: a toolset of another
 * organization is invisible, which is how `/my/{slug}` and the REST surface
 * answer 404 rather than 403 for one (design spec §7.4).
 */
@Injectable()
export class ToolsetRepository extends AbstractRepository<ToolsetEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ToolsetEntity, dataSource);
  }

  findOwned(ownerOrgId: string, id: string): Promise<ToolsetEntity | null> {
    return this.findOne({ where: { ownerOrgId, id, deletedAt: IsNull() } });
  }

  findOwnedBySlug(ownerOrgId: string, slug: string): Promise<ToolsetEntity | null> {
    return this.findOne({ where: { ownerOrgId, slug, deletedAt: IsNull() } });
  }

  /** The owner's toolsets among `ids`, deleted ones included (their access entries still read). */
  findOwnedByIds(ownerOrgId: string, ids: readonly string[]): Promise<ToolsetEntity[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.find({ where: { ownerOrgId, id: In([...ids]) } });
  }

  /** The owner's live toolsets with these slugs. */
  findOwnedBySlugs(ownerOrgId: string, slugs: readonly string[]): Promise<ToolsetEntity[]> {
    if (slugs.length === 0) return Promise.resolve([]);
    return this.find({ where: { ownerOrgId, slug: In([...slugs]), deletedAt: IsNull() } });
  }

  /**
   * The owner's toolset holding `slug`: a live one, or a deleted one that was
   * ever shared (its slug is held for good, so an old pinned URL can never
   * name a different toolset). `null` owner: the platform's.
   */
  findHolderOfSlug(ownerOrgId: string | null, slug: string): Promise<ToolsetEntity | null> {
    const qb = this.createQueryBuilder('toolset')
      .where('toolset.slug = :slug', { slug })
      .andWhere('(toolset.deleted_at IS NULL OR toolset.first_shared_at IS NOT NULL)');
    if (ownerOrgId === null) qb.andWhere('toolset.owner_org_id IS NULL');
    else qb.andWhere('toolset.owner_org_id = :ownerOrgId', { ownerOrgId });
    // A live toolset wins over a deleted one in its grace period.
    return qb.orderBy('toolset.deleted_at', 'DESC', 'NULLS FIRST').getOne();
  }

  /** Any toolset by id, whoever owns it — for the cross-organization paths that check sharing. */
  findAnyById(id: string): Promise<ToolsetEntity | null> {
    return this.findOne({ where: { id } });
  }

  findAnyByIds(ids: readonly string[]): Promise<ToolsetEntity[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.find({ where: { id: In([...ids]) } });
  }

  findByUnlistedToken(token: string): Promise<ToolsetEntity | null> {
    return this.findOne({ where: { unlistedToken: token } });
  }

  countOwned(ownerOrgId: string): Promise<number> {
    return this.count({ where: { ownerOrgId, deletedAt: IsNull() } });
  }

  /** Held slugs (live, or ever shared) that start with `prefix`, for generating a free one. */
  async slugsLike(ownerOrgId: string, prefix: string): Promise<string[]> {
    const rows = await this.createQueryBuilder('toolset')
      .select('toolset.slug', 'slug')
      .where('toolset.owner_org_id = :ownerOrgId', { ownerOrgId })
      .andWhere('(toolset.deleted_at IS NULL OR toolset.first_shared_at IS NOT NULL)')
      .andWhere('toolset.slug LIKE :prefix', { prefix: `${prefix}%` })
      .getRawMany<{ slug: string }>();
    return rows.map((row) => row.slug);
  }
}

/** `toolset_entries`, always read and written by toolset id. */
@Injectable()
export class ToolsetEntryRepository extends AbstractRepository<ToolsetEntryEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ToolsetEntryEntity, dataSource);
  }

  /** The entries of every toolset in `toolsetIds`, in position order. */
  async findByToolsets(toolsetIds: readonly string[]): Promise<ToolsetEntryEntity[]> {
    if (toolsetIds.length === 0) return [];
    return this.find({
      where: { toolsetId: In([...toolsetIds]) },
      order: { toolsetId: 'ASC', position: 'ASC' },
    });
  }
}
