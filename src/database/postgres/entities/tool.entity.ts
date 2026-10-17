import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One tool contract's identity: `tools` (design spec §7.2).
 *
 * Platform-owned, so not organization-scoped: a STANDARD tool belongs to no
 * tenant, and a PROVIDER tool (T4) names its owner in {@link ownerOrgId}.
 * The id is the seed's own uuid, never generated, because every binding,
 * intent and verdict already names it.
 *
 * The contract itself — schemas, summary, examples — is in `tool_versions`
 * (T3). The database is the source of truth; the seed only upserts version
 * 1.0.0 of each seeded tool at boot, for local runs and tests (§13 D4).
 */
@Entity('tools')
export class ToolEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id: string;

  /** At most 48 characters (NFR-7). Unique across both kinds. */
  @Column({ name: 'name', type: 'varchar', length: 48 })
  name: string;

  /** `STANDARD` | `PROVIDER` — `ToolKind`. */
  @Column({ name: 'kind', type: 'varchar', length: 16 })
  kind: string;

  /** The provider organization behind a PROVIDER tool; `null` for STANDARD. */
  @Column({ name: 'owner_org_id', type: 'uuid', nullable: true })
  ownerOrgId: string | null;

  @Column({ name: 'category', type: 'varchar', length: 64 })
  category: string;

  @Column({ name: 'tags', type: 'text', array: true, default: () => `'{}'::text[]` })
  tags: string[];

  /** `PRIVATE` | `UNLISTED` | `LISTED`. Always `LISTED` for STANDARD. */
  @Column({ name: 'visibility', type: 'varchar', length: 16 })
  visibility: string;

  @Column({ name: 'review_status', type: 'varchar', length: 16, nullable: true })
  reviewStatus: string | null;

  @Column({ name: 'review_note', type: 'varchar', length: 1000, nullable: true })
  reviewNote: string | null;

  /** `DRAFT` | `ACTIVE` | `DEPRECATED` | `RETIRED` | `REMOVED` — `ToolStatus`. */
  @Column({ name: 'status', type: 'varchar', length: 16 })
  status: string;

  /**
   * The version unpinned URLs default to (`tool_versions.version`), or `null`
   * before the first publish. Moved by an operator, two-person, for a new
   * major; by the publish itself for a minor or patch of the current major.
   */
  @Column({ name: 'current_version', type: 'int', nullable: true })
  currentVersion: number | null;

  /** The highest version number ever handed out, discarded drafts included: never reused. */
  @Column({ name: 'last_version_number', type: 'int', default: 0 })
  lastVersionNumber: number;

  /** Named by deprecation and retirement notices when another tool replaces this one. */
  @Column({ name: 'replacement_tool_id', type: 'uuid', nullable: true })
  replacementToolId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
