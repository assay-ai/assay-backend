import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One published version of a toolset: an immutable snapshot of everything its
 * URLs serve (design spec §7.2, §7.7). The database refuses UPDATE and DELETE
 * on these rows; `entries` has the shape of `SnapshotEntry[]`.
 */
@Entity('toolset_versions')
export class ToolsetVersionEntity {
  @PrimaryColumn({ name: 'toolset_id', type: 'uuid' })
  toolsetId: string;

  @PrimaryColumn({ name: 'version', type: 'int' })
  version: number;

  @Column({ name: 'entries', type: 'jsonb' })
  entries: unknown;

  /** The entries' tool ids, in order, for access resolution. */
  @Column({ name: 'tool_ids', type: 'uuid', array: true })
  toolIds: string[];

  @Column({ name: 'discovery', type: 'varchar', length: 16 })
  discovery: string;

  @Column({ name: 'search_threshold', type: 'int' })
  searchThreshold: number;

  @Column({ name: 'pinned_tools', type: 'text', array: true })
  pinnedTools: string[];

  @Column({ name: 'name', type: 'varchar', length: 80 })
  name: string;

  @Column({ name: 'description', type: 'varchar', length: 280, nullable: true })
  description: string | null;

  @Column({ name: 'icon', type: 'varchar', length: 32, nullable: true })
  icon: string | null;

  @Column({ name: 'changelog', type: 'varchar', length: 500, nullable: true })
  changelog: string | null;

  /** `PRIVATE` | `UNLISTED` | `PUBLIC`: the visibility it was published with. */
  @Column({ name: 'shared_as', type: 'varchar', length: 16 })
  sharedAs: string;

  @Column({ name: 'published_at', type: 'timestamptz' })
  publishedAt: Date;
}
