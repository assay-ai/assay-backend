import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** `PENDING` until a second operator approves or rejects it, or it expires. */
export type OperatorApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

/**
 * One two-person action waiting for its second person.
 *
 * Written by `OperatorApprovalService` when a two-person route is called, and
 * moved to `APPROVED` inside the same transaction as the action it approves
 * (`OverrideLogService.perform`), so an approval is never marked done for an
 * action that rolled back, and two approvers racing produce one execution.
 *
 * No `organizationId`: like `operators`, this belongs to the platform.
 */
@Entity('operator_approvals')
@Index('idx_operator_approvals_status_created', ['status', 'createdAt'])
export class OperatorApprovalEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  /** The queued action, e.g. `account.unblock` — see `APPROVAL_ACTIONS`. */
  @Column({ name: 'action', type: 'varchar', length: 64 })
  action: string;

  /** What the action is about, `<type>:<id>`, for the inbox. */
  @Column({ name: 'target', type: 'varchar', length: 128 })
  target: string;

  /** The original request, exactly as it will be re-run. */
  @Column({ name: 'payload', type: 'jsonb' })
  payload: Record<string, unknown>;

  /** SHA-256 hex of the canonical `payload`. */
  @Column({ name: 'payload_hash', type: 'varchar', length: 64 })
  payloadHash: string;

  @Column({ name: 'requested_by', type: 'uuid' })
  requestedBy: string;

  @Column({ name: 'approved_by', type: 'uuid', nullable: true })
  approvedBy: string | null;

  @Column({ name: 'rejected_by', type: 'uuid', nullable: true })
  rejectedBy: string | null;

  @Column({ name: 'status', type: 'varchar', length: 16, default: 'PENDING' })
  status: OperatorApprovalStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
