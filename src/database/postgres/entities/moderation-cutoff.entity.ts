import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * An operator's delist or takedown of a toolset or handle (design spec FR-18):
 * in force from `acted_at`, reverted automatically unless a second operator
 * confirms it before `confirm_by` (72 hours).
 */
@Entity('moderation_cutoffs')
export class ModerationCutoffEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  /** `TOOLSET` | `HANDLE`. */
  @Column({ name: 'target_type', type: 'varchar', length: 16 })
  targetType: string;

  /** A toolset id, or a handle. */
  @Column({ name: 'target_id', type: 'varchar', length: 64 })
  targetId: string;

  /** `DELIST` | `TAKEDOWN`. */
  @Column({ name: 'action', type: 'varchar', length: 16 })
  action: string;

  @Column({ name: 'acted_by', type: 'uuid' })
  actedBy: string;

  @Column({ name: 'acted_at', type: 'timestamptz' })
  actedAt: Date;

  @Column({ name: 'confirm_by', type: 'timestamptz' })
  confirmBy: Date;

  @Column({ name: 'confirmed_by', type: 'uuid', nullable: true })
  confirmedBy: string | null;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt: Date | null;

  @Column({ name: 'reverted_by', type: 'uuid', nullable: true })
  revertedBy: string | null;

  @Column({ name: 'reverted_at', type: 'timestamptz', nullable: true })
  revertedAt: Date | null;

  /** `EXPIRED` (nobody confirmed in time), `REJECTED` (the checker disagreed), `LIFTED`, `REASSIGNED`. */
  @Column({ name: 'revert_reason', type: 'varchar', length: 16, nullable: true })
  revertReason: string | null;

  @Column({ name: 'report_id', type: 'uuid', nullable: true })
  reportId: string | null;

  @Column({ name: 'note', type: 'varchar', length: 1000 })
  note: string;
}
