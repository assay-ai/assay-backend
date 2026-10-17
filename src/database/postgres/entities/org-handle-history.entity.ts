import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A handle that left its organization (design spec §7.1): renamed by an
 * operator (an alias until `alias_until`, then held), or taken down and
 * reassigned. A row with no `reassigned_at` holds its handle for good.
 */
@Entity('org_handle_history')
export class OrgHandleHistoryEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ name: 'old_handle', type: 'varchar', length: 24 })
  oldHandle: string;

  @Column({ name: 'org_id', type: 'uuid' })
  orgId: string;

  /** `RENAME` | `TAKEDOWN` | `ORG_DELETED`. */
  @Column({ name: 'reason', type: 'varchar', length: 16 })
  reason: string;

  @Column({ name: 'new_handle', type: 'varchar', length: 24, nullable: true })
  newHandle: string | null;

  @Column({ name: 'changed_at', type: 'timestamptz' })
  changedAt: Date;

  @Column({ name: 'alias_until', type: 'timestamptz', nullable: true })
  aliasUntil: Date | null;

  @Column({ name: 'reassigned_to_org_id', type: 'uuid', nullable: true })
  reassignedToOrgId: string | null;

  @Column({ name: 'reassigned_at', type: 'timestamptz', nullable: true })
  reassignedAt: Date | null;
}
