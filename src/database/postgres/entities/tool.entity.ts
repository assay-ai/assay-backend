import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One tool contract's identity: `tools` (design spec §7.2).
 *
 * Platform-owned, so not organization-scoped: a STANDARD tool belongs to no
 * tenant, and a PROVIDER tool (T4) names its owner in {@link ownerOrgId}.
 * The id is the seed's own uuid, never generated, because every binding,
 * intent and verdict already names it.
 *
 * Schemas and descriptions are not here yet. In T1 the seed still carries the
 * contract and `ToolRegistrySeeder` mirrors its identity into this table at
 * boot; `tool_versions` (T3) moves the contract into the database.
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

  /** `ACTIVE` | `DEPRECATED` | `RETIRED` | `REMOVED` — `ToolStatus`. */
  @Column({ name: 'status', type: 'varchar', length: 16 })
  status: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
