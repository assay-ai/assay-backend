import { Column, Entity, Index } from 'typeorm';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * An internal human.
 *
 * The data model had no internal identity, and every override, decision and
 * approval is unattributable without one. Everything in arbitration that takes
 * money — a decision, a second signature, a cancelled proposal — needs a name
 * on it, and `McpSession` has never carried one.
 *
 * ## No secret in this table
 *
 * An operator signs in by signing the console's sign-in message with the
 * wallet named in `wallet_address` (EIP-4361, `OperatorSignInService`). What
 * the sign-in issues is a short-lived session held in Redis; this row is the
 * **authority**: which roles the operator holds, what they may spend without a
 * second approver, and whether they are still allowed in. Every request
 * re-reads it, so removing or suspending an operator ends their access at
 * once, whatever session they hold.
 *
 * ## No `organizationId`, deliberately
 *
 * `docs/architecture.md` requires it on every business table. This is one of
 * two documented exceptions (the other is
 * `override_log_entries.organization_id`, which is nullable). An operator is
 * not a tenant's user. Giving the row a tenant would either invent a fake
 * "platform" organization that then appears in every tenant-scoped aggregate,
 * or imply that an adjudicator belongs to the provider they are judging — which
 * is precisely the conflict of interest to avoid.
 *
 * ## Roles are a list, not a level
 *
 * The override register assigns each row to named functions — `SRE`, `ADJ`,
 * `ADJL`, `POL`, `POLA`, `TRE`, `TREA`, `BD`, `SUP`, `CMP`, `SEC` — and they
 * are not ordered. An adjudication lead is not "an adjudicator plus one"; they
 * may decide the rows `ADJ` cannot and may not sweep the rows `SRE` can. A
 * single `level` column would have to invent an ordering the register does not
 * have.
 *
 * An operator with an empty `roles` array authenticates and can do nothing.
 * That is a useful state — onboarding, off-boarding, a suspended review — and
 * not an error.
 */
@Entity('operators')
@Index('uq_operators_subject', ['subject'], { unique: true })
@Index('uq_operators_wallet_address', ['walletAddress'], { unique: true })
export class OperatorEntity extends AbstractEntityWithoutSoftDelete {
  /**
   * A short handle for the operator, e.g. `dan@`.
   *
   * Rendered verbatim in the override log and the adjudication queue's `Owner`
   * column — written as e.g. `dan@`, which is what a real deployment would
   * carry here.
   */
  @Column({ name: 'subject', type: 'varchar', length: 256 })
  subject: string;

  @Column({ name: 'display_name', type: 'varchar', length: 128 })
  displayName: string;

  @Column({ name: 'email', type: 'varchar', length: 256 })
  email: string;

  /** `OperatorRole[]`, stored as a JSON array. */
  @Column({ name: 'roles', type: 'jsonb', default: () => `'[]'::jsonb` })
  roles: string[];

  /**
   * Authority is bounded by a number, not by a role. Minor units of the
   * platform asset, per single action. `null` means unbounded, which is correct
   * for roles whose actions move no money.
   *
   * `numeric(78,0)` as a string, like every other amount on this schema.
   */
  @Column({
    name: 'authority_limit_minor',
    type: 'numeric',
    precision: 78,
    scale: 0,
    nullable: true,
  })
  authorityLimitMinor: string | null;

  /**
   * The EVM address the operator signs in with, lower-case. `null` only for a
   * row that has not been linked to a wallet yet, which cannot sign in.
   */
  @Column({ name: 'wallet_address', type: 'varchar', length: 42, nullable: true })
  walletAddress: string | null;

  /** `ACTIVE` | `SUSPENDED` | `REMOVED`. Only `ACTIVE` may sign in or act. */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'ACTIVE' })
  status: string;

  @Column({ name: 'suspended_at', type: 'timestamptz', nullable: true })
  suspendedAt: Date | null;

  /** Set exactly when `status = 'REMOVED'`. The row stays: the register references it. */
  @Column({ name: 'removed_at', type: 'timestamptz', nullable: true })
  removedAt: Date | null;

  /**
   * Stamped by the guard on a successful resolve.
   *
   * Not authorization — a stale one authorises nothing. It exists because read
   * tools are audited too, and "which internal accounts are still being used"
   * is the cheapest possible version of that: an operator who left three months
   * ago and whose token is still resolving is visible here without any further
   * instrumentation. Buffered by `LastSeenRecorder` and written in a batch
   * every 30 s; the directory overlays `LastSeenRecorder.pending`.
   */
  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;
}
