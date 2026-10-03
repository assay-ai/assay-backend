import { Column, Entity, Index } from 'typeorm';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * The override register.
 *
 * One row per manual intervention: who, when, why, and what the state was
 * before and after. The reason fits in one sentence — *"A decision that takes
 * someone else's money must leave a trace."*
 *
 * ## The precedent this table exists against
 *
 * FTX's `allow_negative` was one boolean added to the balance check at one
 * person's verbal instruction, with no second approver and no record visible to
 * anyone else. Every row in the register is a place that flag could be
 * re-invented. The control is not that the team is trustworthy; it is that the
 * action does not execute until a second identity approves it, **and that the
 * attempt is recorded either way**.
 *
 * ## Append-only, enforced by the database
 *
 * `trg_override_log_entries_append_only` refuses `UPDATE` and `DELETE` at the
 * row level. `evidence_packs` has the same trigger and for a related reason,
 * but this table's case is sharper: an evidence pack is read when someone
 * disputes a machine, and this register is read when someone is suspected of
 * something.
 *
 * A trigger does not stop a superuser with `ALTER TABLE … DISABLE TRIGGER`, and
 * nothing in Postgres does. What it stops is an ORM call, a migration written
 * in a hurry and a support script — which is every way a table like this has
 * actually been corrupted anywhere it has been built before. The class exposes
 * no mutator and the repository has no update method; all three are hedges
 * against the same mistake and none is sufficient alone.
 *
 * `updated_at` and `version` are present so the row fits
 * `AbstractEntityWithoutSoftDelete` like every other table. They are never
 * expected to move, because the trigger refuses the write that would move them.
 *
 * ## `organizationId` is nullable, and that is the second documented exception
 *
 * `docs/architecture.md` requires the column on every business table. Here it
 * names the **subject** of the intervention, so a tenant can be shown their own
 * history — *"the subject is notified"*. Killing a policy, rotating a verifier
 * key or halting payouts has no subject tenant, and a sentinel value in an
 * append-only record is a lie that survives forever. The other exception is
 * `operators`, which has no such column at all.
 *
 * ## Why the reason length rule applies to exactly one code
 *
 * A case decision requires a reason code from a closed list **and** a
 * hand-written explanation of at least 120 characters, with no path around it
 * for a lead or an admin. `chk_override_log_entries_decision_reason_length`
 * enforces that on `S-3` — deciding a dispute — and not on the register's
 * cheaper rows. Applying a 120-character floor to "released a stuck hold" would
 * teach operators to paste filler, and filler in an audit trail is worse than a
 * short true sentence: it reads as diligence.
 */
@Entity('override_log_entries')
@Index('idx_override_log_entries_feed', ['createdAt', 'id'])
@Index('idx_override_log_entries_actor', ['actorOperatorId', 'createdAt'])
@Index('idx_override_log_entries_target', ['targetType', 'targetId'])
@Index('idx_override_log_entries_family', ['family', 'createdAt'])
export class OverrideLogEntryEntity extends AbstractEntityWithoutSoftDelete {
  /** The subject's tenant, when the intervention has one. */
  @Index('idx_override_log_entries_organization_id')
  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  /**
   * The register's family letter: `V`erification, `P`olicy, `S`lashing,
   * `M`oney, `A`ccess, `K`eys. The override log filters on it.
   */
  @Column({ name: 'family', type: 'char', length: 1 })
  family: string;

  /**
   * The register row, e.g. `S-3`, `V-6`, `M-2`. Constrained to begin with
   * `family`, so a mis-filed row cannot hide from the console's family filter.
   */
  @Column({ name: 'code', type: 'varchar', length: 8 })
  code: string;

  /** Dotted past tense, matching `audit_log_entries.action`. */
  @Column({ name: 'action', type: 'varchar', length: 64 })
  action: string;

  @Column({ name: 'actor_operator_id', type: 'uuid' })
  actorOperatorId: string;

  /**
   * The checker, for two-person rows. Constrained to be a different person than
   * the actor — *"no self-approval enforced in code"*, enforced here
   * too, because code that can be edited is not the same guarantee as a
   * constraint that refuses the row.
   */
  @Column({ name: 'approver_operator_id', type: 'uuid', nullable: true })
  approverOperatorId: string | null;

  /** `SINGLE` | `TWO_PERSON` | `BREAK_GLASS`. */
  @Column({ name: 'approval_mode', type: 'varchar', length: 16 })
  approvalMode: string;

  @Column({ name: 'target_type', type: 'varchar', length: 32 })
  targetType: string;

  @Column({ name: 'target_id', type: 'varchar', length: 128 })
  targetId: string;

  /** From a closed enumeration per family — not free text. */
  @Column({ name: 'reason_code', type: 'varchar', length: 64 })
  reasonCode: string;

  @Column({ name: 'reason', type: 'text' })
  reason: string;

  /**
   * Both NOT NULL. "the state before and after" is the whole requirement; an entry
   * that records only the new value cannot answer what was changed, which is
   * the question actually asked of it.
   *
   * They are the *relevant* fields, not whole rows: a diff nobody can read is
   * the same failure as no diff.
   */
  @Column({ name: 'before', type: 'jsonb' })
  before: Record<string, unknown>;

  @Column({ name: 'after', type: 'jsonb' })
  after: Record<string, unknown>;

  @Column({ name: 'ticket_ref', type: 'varchar', length: 128, nullable: true })
  ticketRef: string | null;

  /**
   * Break-glass is allowed and is always reviewed. Single-actor emergency
   * execution moves the audit from before the fact to after it; it does not
   * remove it. Constrained to agree with `approval_mode`.
   */
  @Column({ name: 'break_glass', type: 'boolean', default: false })
  breakGlass: boolean;

  /** The HTTP request this happened under, for cross-system tracing. */
  @Column({ name: 'request_id', type: 'varchar', length: 64, nullable: true })
  requestId: string | null;
}
