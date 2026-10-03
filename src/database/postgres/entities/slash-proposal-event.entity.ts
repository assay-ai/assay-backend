import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One line of the case timeline the dispute screen renders.
 *
 * ## Why this is not the override log
 *
 * They look similar and they are answering different questions, so merging them
 * would damage both.
 *
 * The **override log** is the register of *manual interventions*, each one a
 * row someone will be asked to justify. Its value comes from being short and
 * from every entry meaning the same kind of thing. Folding "the notification
 * was delivered" into it would bury `S-3` and `M-2` under machine noise, and an
 * audit register nobody can read is not one.
 *
 * The **timeline** is the provider's view of their own case, and most of what
 * belongs on it is not an intervention at all: proposed, delivered,
 * acknowledged, disputed, auto-closed. The dispute screen's subtitle — *"both
 * clocks are visible, including ours"* — is a promise this table keeps and the
 * register could not.
 *
 * Where an event *is* an intervention, both rows are written, in one
 * transaction, by `OverrideLogService`. The timeline entry carries the
 * override entry's id in `detail.overrideLogEntryId`, so the case view can link
 * to the register without duplicating its contents.
 *
 * ## Append-only by construction rather than by trigger
 *
 * Unlike `override_log_entries`, this table has no trigger. It is a rendering
 * of things that happened, not the evidence that they were authorised; a
 * mis-written timeline row is a display bug, and a mis-written override row is
 * a cover-up. Guarding both at the same cost would have suggested they carry
 * the same weight.
 */
@Entity('slash_proposal_events')
@Index('idx_slash_proposal_events_proposal_occurred_at', ['proposalId', 'occurredAt'])
export class SlashProposalEventEntity extends OrganizationScopedEntityWithoutSoftDelete {
  @Column({ name: 'proposal_id', type: 'uuid' })
  proposalId: string;

  /**
   * When the thing happened, which is not always when the row was written.
   *
   * A delivery confirmation arrives late; a sweeper runs on a tick. The
   * timeline orders on this, and `created_at` is kept as the write time so the
   * two can be compared when a timeline looks wrong.
   */
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  /**
   * `PROPOSED`, `NOTIFIED`, `ACKNOWLEDGED`, `DISPUTE_FILED`, `ASSIGNED`,
   * `DECIDED`, `SECONDED`, `SECOND_OBJECTED`, `AUTO_CLOSED`,
   * `AUTO_OVERTURNED_PLATFORM_MISS`, `WAIVED`, `CANCELLED`, `EXECUTED`,
   * `REVERSED`, `SWEEP_APPLIED`, `EXECUTED_AFTER_CLOSURE`.
   *
   * The chain lifecycle adds `CHAIN_PROPOSED`, `CHAIN_PROPOSAL_ADOPTED`,
   * `CHAIN_CANCELLED` and `CHAIN_VOIDED`.
   *
   * `EXECUTED_AFTER_CLOSURE` is the one that looks like a contradiction and is
   * not: `execute_slash` consults nobody but a fee payer, so a stranger may
   * spend a standing record after this platform has already closed the case.
   * The row then carries the decision AND the money, and this is the timeline's
   * word for that.
   *
   * There is no CHECK on the column (`varchar(48)`), so this list is the only
   * place a reader learns what kinds exist. Add to it when you add one.
   */
  @Column({ name: 'kind', type: 'varchar', length: 48 })
  kind: string;

  /** `provider` | `operator` | `system`. NULL actor exactly when `system`. */
  @Column({ name: 'actor_type', type: 'varchar', length: 16 })
  actorType: string;

  @Column({ name: 'actor_id', type: 'varchar', length: 128, nullable: true })
  actorId: string | null;

  /** One line, already written for a human. The timeline renders it verbatim. */
  @Column({ name: 'summary', type: 'varchar', length: 512 })
  summary: string;

  @Column({ name: 'detail', type: 'jsonb', default: () => `'{}'::jsonb` })
  detail: Record<string, unknown>;
}
