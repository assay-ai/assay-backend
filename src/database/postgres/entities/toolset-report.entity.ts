import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** A report against a toolset, a tool or a handle (design spec §7.2, FR-15). */
@Entity('toolset_reports')
export class ToolsetReportEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ name: 'toolset_id', type: 'uuid', nullable: true })
  toolsetId: string | null;

  @Column({ name: 'tool_id', type: 'uuid', nullable: true })
  toolId: string | null;

  @Column({ name: 'handle', type: 'varchar', length: 24, nullable: true })
  handle: string | null;

  @Column({ name: 'reporter_org_id', type: 'uuid' })
  reporterOrgId: string;

  @Column({ name: 'reason', type: 'varchar', length: 500 })
  reason: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  /** `DISMISSED` | `DELISTED` | `TAKEN_DOWN` | `ACTIONED`. */
  @Column({ name: 'resolution', type: 'varchar', length: 32, nullable: true })
  resolution: string | null;

  @Column({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedBy: string | null;
}
