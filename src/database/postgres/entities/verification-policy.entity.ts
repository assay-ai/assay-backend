import { Column, Entity, Index } from 'typeorm';
import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * One version of one verification policy.
 *
 * **Immutable per version.** A policy is never edited in place; a change is a
 * new row with the next `version`. That is not a style preference — every
 * verdict records the `(policy_id, version)` that decided it, and an editable
 * policy makes that recording a lie the moment somebody fixes a typo. A dispute
 * resolves months later by re-reading this row.
 *
 * The only mutable columns are lifecycle transitions: promotion, withdrawal,
 * archival. Each writes its own audit fields alongside, so the row carries who
 * did what, when, and on what evidence.
 *
 * **Not organization-scoped**, and this is the second documented exception to
 * `docs/architecture.md` after `reconciliation_runs`. A verification policy
 * belongs to a *tool*, and the tool catalogue is platform-level in the MVP —
 * `InMemoryToolCatalogue` has no tenant, and neither does the router that reads
 * it. Adding an `organization_id` here would invent a tenant boundary that no
 * other object in the catalogue has, and the partial unique index below — at
 * most one `ACTIVE` policy per tool — would then be per-tenant, which is the
 * opposite of what "one policy per tool, versioned" means.
 */
@Entity('verification_policies')
@Index('idx_verification_policies_tool_lifecycle', ['toolId', 'lifecycle'])
export class VerificationPolicyEntity extends AbstractEntityWithoutSoftDelete {
  /**
   * The logical policy id, stable across versions.
   *
   * A slug rather than a uuid — it is typed into the kill switch by an operator
   * during an incident, and `search_web.default` is a thing a human can say out
   * loud to another human at 3am. `uuid` is not.
   */
  @Column({ name: 'policy_id', type: 'varchar', length: 128 })
  policyId: string;

  /** Monotonic per `policy_id`, from 1. */
  @Column({ name: 'policy_version', type: 'int' })
  policyVersion: number;

  @Column({ name: 'tool_id', type: 'uuid' })
  toolId: string;

  /** One of `PolicyLifecycle`; a CHECK constraint holds the enum. */
  @Column({ name: 'lifecycle', type: 'varchar', length: 16 })
  lifecycle: string;

  /**
   * The `DecisionPolicy` document — verifiers, clauses, `otherwise`.
   *
   * Stored whole rather than shredded into rows. The aggregator takes it as one
   * value and a dispute replays it as one value; a shredded form would let a
   * partially-applied migration produce a policy that is *almost* the one that
   * decided the call.
   */
  @Column({ name: 'decision_document', type: 'jsonb' })
  decisionDocument: Record<string, unknown>;

  /**
   * The `VerificationPolicy` document — schema, rules, thresholds.
   *
   * Nullable: a decision policy over third-party verifiers alone needs no local
   * checks to run, which is the case the aggregator leaves room for.
   */
  @Column({ name: 'verification_document', type: 'jsonb', nullable: true })
  verificationDocument: Record<string, unknown> | null;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy: string;

  /**
   * When the promote gate was cleared. `NULL` until it is.
   *
   * A CHECK constraint makes `lifecycle = 'ACTIVE'` impossible while this is
   * null. That is the promote gate's third and last line of defence — the one a
   * future service, a migration script or a hand-typed `UPDATE` cannot route
   * around.
   */
  @Column({ name: 'promoted_at', type: 'timestamptz', nullable: true })
  promotedAt: Date | null;

  /** Never the requester. `evaluatePromotion` refuses a self-approval. */
  @Column({ name: 'promoted_by', type: 'varchar', length: 128, nullable: true })
  promotedBy: string | null;

  /** The `PromotionEvidence` as submitted: sample counts and the measured rate. */
  @Column({ name: 'promotion_evidence', type: 'jsonb', nullable: true })
  promotionEvidence: Record<string, unknown> | null;

  @Column({ name: 'withdrawn_at', type: 'timestamptz', nullable: true })
  withdrawnAt: Date | null;

  @Column({ name: 'withdrawn_by', type: 'varchar', length: 128, nullable: true })
  withdrawnBy: string | null;

  /**
   * Why it was pulled.
   *
   * Required whenever `withdrawn_at` is set, by CHECK. An incident review that
   * finds a policy withdrawn with no reason has found nothing.
   */
  @Column({ name: 'withdrawn_reason', type: 'varchar', length: 512, nullable: true })
  withdrawnReason: string | null;
}
