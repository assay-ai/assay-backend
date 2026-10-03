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
 * ## The secret is not in this table
 *
 * Bearer tokens live in `OPERATOR_CREDENTIALS_FILE` and are matched by SHA-256
 * digest at request time, exactly as `ConfigMcpSessionSource` does for agents.
 * This row is the **authority**: which roles the subject holds, what they may
 * spend without a second approver, and whether they are still allowed in.
 *
 * Splitting it that way buys one specific property: **revocation does not
 * require a deploy.** Setting `status = 'SUSPENDED'` refuses the next request
 * from a token that is still perfectly valid, which is what you need at 03:00
 * when the question is whether a laptop was stolen. A credential file is edited
 * by whoever can reach the box; a row is edited by whoever can reach the
 * database, and the two are deliberately different people.
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
export class OperatorEntity extends AbstractEntityWithoutSoftDelete {
  /**
   * The SSO subject this operator will eventually be, and today the key the
   * credential file maps a token onto.
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

  /** `ACTIVE` | `SUSPENDED`. */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'ACTIVE' })
  status: string;

  @Column({ name: 'suspended_at', type: 'timestamptz', nullable: true })
  suspendedAt: Date | null;

  /**
   * Stamped by the guard on a successful resolve.
   *
   * Not authorization — a stale one authorises nothing. It exists because read
   * tools are audited too, and "which internal accounts are still being used"
   * is the cheapest possible version of that: an operator who left three months
   * ago and whose token is still resolving is visible here without any further
   * instrumentation.
   */
  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;
}
