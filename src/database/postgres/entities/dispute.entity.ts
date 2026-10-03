import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * A challenge to something the platform decided.
 *
 * ## One table for both sides
 *
 * A provider disputing a proposed SLA breach and an agent challenging a verdict
 * that charged them are the same object: a claim against a decision, with a
 * clock, evidence, and an outcome that may partially overturn the original.
 * Two tables would duplicate the state machine and let the two drift, which
 * matters because the same verdict can be disputed from both directions at
 * once. `subject_type` says what is being challenged.
 *
 * ## The clock starts on acknowledgement, not on issue
 *
 * `deadline_at` is nullable and stays null until `acknowledged_at` is set. A
 * fixed 72 hours running from issuance can be consumed entirely by a weekend
 * and a dead webhook, and a due-process window the respondent never learned
 * about is not due process. Storing both timestamps is what lets the deadline
 * be defended later.
 *
 * ## Append-only
 *
 * `WithoutSoftDelete`, for the same reason as the audit log: this row is the
 * evidence that a process was followed. State transitions overwrite `state`,
 * but the row is never removed, and every transition also writes an
 * `audit_log_entries` row.
 *
 * ## What is deliberately NOT here
 *
 * The **adjudication** — who reviews, on what SLA, how a partial overturn
 * restores stake — lives in the arbitration columns below. This table stores
 * and serves disputes; it does not decide them. `resolution` is written by
 * whatever process eventually does.
 */
@Entity('disputes')
@Index('idx_disputes_subject', ['organizationId', 'subjectType', 'subjectId'])
@Index('idx_disputes_state', ['organizationId', 'state'])
export class DisputeEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /** `SLA_WINDOW` | `VERDICT` | `PAYMENT_INTENT`. */
  @Column({ name: 'subject_type', type: 'varchar', length: 24 })
  subjectType: string;

  @Column({ name: 'subject_id', type: 'varchar', length: 128 })
  subjectId: string;

  /**
   * Set when the disputing party is a provider.
   *
   * Nullable because the agent side of a dispute has no provider — and because
   * `provider_id` is nullable on `payment_intents` too, so a dispute over an
   * unrouted call has nothing to point at.
   */
  @Column({ name: 'provider_id', type: 'uuid', nullable: true })
  providerId: string | null;

  /** `OPEN` | `UNDER_REVIEW` | `UPHELD` | `PARTIALLY_UPHELD` | `REJECTED` | `WITHDRAWN`. */
  @Column({ name: 'state', type: 'varchar', length: 24 })
  state: string;

  /**
   * What kind of claim this is, which decides what evidence is relevant and who
   * reviews it. `MAPPING_ERROR`, `FALSE_POSITIVE`, `UPSTREAM_OUTAGE`,
   * `MEASUREMENT_DISPUTED`, …
   */
  @Column({ name: 'claim_type', type: 'varchar', length: 32 })
  claimType: string;

  @Column({ name: 'reason', type: 'varchar', length: 2048 })
  reason: string;

  /** Free-form supporting material, as submitted. Never rewritten. */
  @Column({ name: 'evidence', type: 'jsonb', default: () => `'[]'::jsonb` })
  evidence: unknown[];

  @Column({ name: 'opened_by', type: 'varchar', length: 128 })
  openedBy: string;

  /** When the respondent confirmed receipt. Until then, `deadline_at` is null. */
  @Column({ name: 'acknowledged_at', type: 'timestamptz', nullable: true })
  acknowledgedAt: Date | null;

  /** Derived from `acknowledged_at`, never from `created_at`. */
  @Column({ name: 'deadline_at', type: 'timestamptz', nullable: true })
  deadlineAt: Date | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ name: 'resolved_by', type: 'varchar', length: 128, nullable: true })
  resolvedBy: string | null;

  /** The reasoning, which the dispute screen shows to the disputing party verbatim. */
  @Column({ name: 'resolution_note', type: 'varchar', length: 2048, nullable: true })
  resolutionNote: string | null;

  /**
   * What was given back, when a dispute is upheld in whole or in part.
   *
   * `numeric(78,0)` and nullable: a dispute can be upheld and restore nothing
   * (a corrected statistic, an expunged strike), and `0` would not distinguish
   * that from "upheld, restored zero of the amount claimed".
   */
  @Column({ name: 'restored_amount', type: 'numeric', precision: 78, scale: 0, nullable: true })
  restoredAmount: string | null;

  @Column({ name: 'asset_id', type: 'varchar', length: 256, nullable: true })
  assetId: string | null;

  @Column({ name: 'decimals', type: 'int', nullable: true })
  decimals: number | null;

  // ── Arbitration ───────────────────────────────────────────────────────────
  //
  // This table shipped with a claim, an acknowledgement, a deadline and a
  // resolution, and its own docstring said the adjudication lived elsewhere.
  // The columns below are that: an owner, our own clock, and a decision that is
  // more than a state.

  /**
   * The named human working this case. NULL is rendered in red in the console,
   * on purpose: a dispute with no owner and a running clock is the exact
   * failure the escalation rule guards against.
   */
  @Column({ name: 'assigned_operator_id', type: 'uuid', nullable: true })
  assignedOperatorId: string | null;

  @Column({ name: 'assigned_at', type: 'timestamptz', nullable: true })
  assignedAt: Date | null;

  /**
   * When **we** must have decided by.
   *
   * If we fail to decide before the timelock expires, the dispute is
   * automatically overturned. That is the only rule that costs us something for
   * being slow; every other deadline runs against the provider. `deadlineAt`
   * above is theirs, this one is ours, and the dispute screen renders both —
   * both clocks are visible, including ours.
   */
  @Column({ name: 'platform_due_at', type: 'timestamptz', nullable: true })
  platformDueAt: Date | null;

  /**
   * One of the six outcomes, stated from the **proposal's** point of view.
   *
   * Note the polarity: this column and `state` describe the same decision in
   * opposite directions. `state = 'UPHELD'` means the provider's objection was
   * upheld, and the matching `outcome` is one of the four `OVERTURNED_*`
   * values. `ARBITRATION_STATE_MAP` is the one place the translation lives.
   */
  @Column({ name: 'outcome', type: 'varchar', length: 40, nullable: true })
  outcome: string | null;

  /**
   * A closed enumeration, not free text. Free-text decisions cannot be
   * aggregated, cannot be searched for precedent and cannot be audited, which
   * is why the vocabulary is closed.
   */
  @Column({ name: 'reason_codes', type: 'jsonb', default: () => `'[]'::jsonb` })
  reasonCodes: string[];

  /**
   * The rubric this case was decided under. A case decided under rubric v4 is
   * re-read under rubric v4, so the version has to be on the decision rather
   * than looked up at read time.
   */
  @Column({ name: 'rubric_version', type: 'varchar', length: 16, nullable: true })
  rubricVersion: string | null;

  /** `ADJUDICATOR` | `AUTO_PLATFORM_MISS`. NULL until resolved. */
  @Column({ name: 'resolution_kind', type: 'varchar', length: 24, nullable: true })
  resolutionKind: string | null;

  /** The second signature. */
  @Column({ name: 'seconded_by_operator_id', type: 'uuid', nullable: true })
  secondedByOperatorId: string | null;

  @Column({ name: 'seconded_at', type: 'timestamptz', nullable: true })
  secondedAt: Date | null;

  /** `SIGNED` | `OBJECTED`. */
  @Column({ name: 'second_kind', type: 'varchar', length: 16, nullable: true })
  secondKind: string | null;

  /** Required when the second objects: an objection must also record a reason. */
  @Column({ name: 'second_note', type: 'varchar', length: 2048, nullable: true })
  secondNote: string | null;
}
