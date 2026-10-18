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

  // ── Provider tools (T4, design spec §7.6) ────────────────────────────────

  /** The version under review (PENDING), or the one last decided. May name a draft. */
  @Column({ name: 'review_version', type: 'int', nullable: true })
  reviewVersion: number | null;

  /** The newest version an operator approved: what LISTED surfaces serve. */
  @Column({ name: 'approved_version', type: 'int', nullable: true })
  approvedVersion: number | null;

  @Column({ name: 'review_submitted_at', type: 'timestamptz', nullable: true })
  reviewSubmittedAt: Date | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  /** The operator who decided the last review. */
  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy: string | null;

  /** SHA-256 of the content a pending review is for; an approval must match it. */
  @Column({ name: 'review_content_hash', type: 'varchar', length: 64, nullable: true })
  reviewContentHash: string | null;

  /** Set with `status = REMOVED` by a takedown (FR-18). */
  @Column({ name: 'removed_at', type: 'timestamptz', nullable: true })
  removedAt: Date | null;

  /** Its own takedown (FR-18), standing. */
  @Column({ name: 'taken_down_at', type: 'timestamptz', nullable: true })
  takenDownAt: Date | null;

  /**
   * Its handle's takedown, standing: every tool under the handle stops. Also
   * left by a lifted takedown when the tool has no active handle to serve under.
   */
  @Column({ name: 'handle_removed_at', type: 'timestamptz', nullable: true })
  handleRemovedAt: Date | null;

  /** A LISTED tool's category as its draft under review proposes it. */
  @Column({ name: 'pending_category', type: 'varchar', length: 64, nullable: true })
  pendingCategory: string | null;

  /** A LISTED tool's tags as its draft under review proposes them. */
  @Column({ name: 'pending_tags', type: 'text', array: true, nullable: true })
  pendingTags: string[] | null;

  /** The status a takedown replaced, restored when the cutoff is reverted. */
  @Column({ name: 'status_before_removal', type: 'varchar', length: 16, nullable: true })
  statusBeforeRemoval: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
