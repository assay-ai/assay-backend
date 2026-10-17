import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A named list of tools with provider rules, served as its own MCP server
 * (design spec §7.2). Its entries — the Draft — are `toolset_entries`.
 *
 * Owned by `owner_org_id`, which is `null` only for a platform (Official)
 * toolset. Not an `OrganizationScopedEntity`: the column is the owner, not a
 * tenant every read is scoped to, because a PUBLIC toolset (T2) is read by
 * every organization. `ToolsetRepository` scopes each owner read explicitly.
 */
@Entity('toolsets')
export class ToolsetEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ name: 'owner_org_id', type: 'uuid', nullable: true })
  ownerOrgId: string | null;

  /** `USER` | `PLATFORM` | `PROVIDER` — the badge. */
  @Column({ name: 'publisher_kind', type: 'varchar', length: 16 })
  publisherKind: string;

  @Column({ name: 'slug', type: 'varchar', length: 64 })
  slug: string;

  @Column({ name: 'name', type: 'varchar', length: 80 })
  name: string;

  /** Never sent to a model. */
  @Column({ name: 'description', type: 'varchar', length: 280, nullable: true })
  description: string | null;

  @Column({ name: 'category', type: 'varchar', length: 64, nullable: true })
  category: string | null;

  @Column({ name: 'tags', type: 'text', array: true, default: () => `'{}'::text[]` })
  tags: string[];

  @Column({ name: 'icon', type: 'varchar', length: 32, nullable: true })
  icon: string | null;

  /** `PRIVATE` | `UNLISTED` | `PUBLIC` — see `domain/sharing.ts`. */
  @Column({ name: 'visibility', type: 'varchar', length: 16, default: 'PRIVATE' })
  visibility: string;

  @Column({ name: 'unlisted_token', type: 'varchar', length: 32, nullable: true })
  unlistedToken: string | null;

  @Column({ name: 'listing_status', type: 'varchar', length: 16, nullable: true })
  listingStatus: string | null;

  @Column({ name: 'grace_visibility', type: 'varchar', length: 16, nullable: true })
  graceVisibility: string | null;

  @Column({ name: 'grace_until', type: 'timestamptz', nullable: true })
  graceUntil: Date | null;

  /** Abuse takedown: nothing outside the owner's `/my/` serves it. */
  @Column({ name: 'removed_at', type: 'timestamptz', nullable: true })
  removedAt: Date | null;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @Column({ name: 'latest_version', type: 'int', nullable: true })
  latestVersion: number | null;

  /** `AUTO` | `FULL` | `SEARCH` (served from T2; T1 lists everything). */
  @Column({ name: 'discovery', type: 'varchar', length: 16, default: 'AUTO' })
  discovery: string;

  @Column({ name: 'search_threshold', type: 'int', default: 25 })
  searchThreshold: number;

  /** "Always loaded" tool names, at most 5. */
  @Column({ name: 'pinned_tools', type: 'text', array: true, default: () => `'{}'::text[]` })
  pinnedTools: string[];

  @Column({ name: 'forked_from_id', type: 'uuid', nullable: true })
  forkedFromId: string | null;

  @Column({ name: 'forked_from_version', type: 'int', nullable: true })
  forkedFromVersion: number | null;

  /** The first UNLISTED or PUBLIC share; from then on the slug is held for good. */
  @Column({ name: 'first_shared_at', type: 'timestamptz', nullable: true })
  firstSharedAt: Date | null;

  /** An operator's standing delist; cleared by a relist or a revert. */
  @Column({ name: 'delisted_at', type: 'timestamptz', nullable: true })
  delistedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
