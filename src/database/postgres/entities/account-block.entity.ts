import { Column, Entity, Index } from 'typeorm';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * One block of an account, and its lifting.
 *
 * The source of truth for the blocklist. Every process keeps the active rows in
 * memory (`AccountBlocklistService`) because the check runs on every request,
 * every tool call and every redemption; the rows themselves only change through
 * the operator override register (`A-9` block, `A-10` unblock), so each one has
 * a register entry written in the same transaction.
 *
 * ## Why this table, and not `organizations.status`
 *
 * `organizations.status` already has a `SUSPENDED` value, and it was the first
 * candidate. It does not fit, for four reasons:
 *
 * 1. A wallet is not an organization. A leaked key is blocked by its address,
 *    whichever tenant presents it, and `status` has nowhere to put one.
 * 2. Tenants created from the credential file have no `organizations` row at
 *    all, so a flag on that row cannot block them.
 * 3. A flag says nothing about who, when or why — and lifting a block must
 *    leave both halves on record. Here the row keeps the block and its lifting.
 * 4. A `SUSPENDED` organization is refused at sign-in, reads included. A block
 *    leaves the dashboard's reads open so the account holder can see that, and
 *    why, they are blocked.
 *
 * The refusal still reuses the existing codes: a blocked organization's session
 * is `AUTH_ORGANIZATION_SUSPENDED`, the code the frontend already handles.
 *
 * ## Lifting does not delete
 *
 * Unblocking sets `unblocked_*` on this row. The row stays as the record, and a
 * later block of the same subject is a new row: `uq_account_blocks_active`
 * allows one *active* block per subject key, any number of lifted ones.
 *
 * ## No `organization_id`
 *
 * Like `operators`, this is platform data. A block's subject may be an
 * organization, and is then in `subject`; a wallet block has no tenant at all.
 */
@Entity('account_blocks')
@Index('idx_account_blocks_feed', ['blockedAt', 'id'])
export class AccountBlockEntity extends AbstractEntityWithoutSoftDelete {
  /** `ORGANIZATION` | `WALLET` — `BlockSubjectKind`. */
  @Column({ name: 'subject_kind', type: 'varchar', length: 16 })
  subjectKind: string;

  /** The organization uuid, or the CAIP-10 account, normalised. */
  @Column({ name: 'subject', type: 'varchar', length: 256 })
  subject: string;

  /**
   * What the subject is matched by: the uuid, or `namespace:address` for a
   * wallet — see `subjectKey`. Unique among active blocks.
   */
  @Column({ name: 'subject_key', type: 'varchar', length: 256 })
  subjectKey: string;

  @Column({ name: 'reason_code', type: 'varchar', length: 64 })
  reasonCode: string;

  /** The operator's own words. Internal: never shown to the blocked account. */
  @Column({ name: 'note', type: 'text' })
  note: string;

  @Column({ name: 'ticket_ref', type: 'varchar', length: 128, nullable: true })
  ticketRef: string | null;

  /** `operators.id`. */
  @Column({ name: 'blocked_by', type: 'uuid' })
  blockedBy: string;

  @Column({ name: 'blocked_at', type: 'timestamptz' })
  blockedAt: Date;

  /** `operators.id` of whoever lifted it. Null while the block stands. */
  @Column({ name: 'unblocked_by', type: 'uuid', nullable: true })
  unblockedBy: string | null;

  /** The second operator who approved the lifting (`A-10` is two-person). */
  @Column({ name: 'unblock_approved_by', type: 'uuid', nullable: true })
  unblockApprovedBy: string | null;

  @Column({ name: 'unblocked_at', type: 'timestamptz', nullable: true })
  unblockedAt: Date | null;

  @Column({ name: 'unblock_note', type: 'text', nullable: true })
  unblockNote: string | null;
}
