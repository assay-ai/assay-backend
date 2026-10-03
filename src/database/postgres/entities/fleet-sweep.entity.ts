import { Column, Entity, Index } from 'typeorm';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * One conclusion, carried to every binding the same defect touched.
 *
 * ## Why this is on by default
 *
 * The sweep is on by default, even for providers who have never complained. If
 * we leave them to find it themselves, they will pay for our bug forever and we
 * will never know. Put the other way: **a platform defect is never a
 * single-provider event.** If our response mapping dropped a field, every
 * binding on that tool failed the same way, and only the provider who
 * complained gets relief. That is the difference between an honest system and
 * one that refunds only the noisy.
 *
 * ## Only two outcomes sweep, and the CHECK says which
 *
 * `OVERTURNED_PLATFORM_DEFECT` and `OVERTURNED_POLICY_DEFECT` are findings
 * about **us**, so they generalise. The other four do not:
 *
 * - `UPHELD` and `UPHELD_RECALCULATED` are findings about the provider.
 * - `OVERTURNED_GRIEFING` is about one agent's traffic against one binding.
 * - `OVERTURNED_INSUFFICIENT_EVIDENCE` is about one window's sample size.
 *
 * Sweeping any of those four would cancel penalties on providers whose facts
 * were never in question, which is not generosity — it is the same defect as
 * levying them, pointed the other way.
 *
 * ## No `organizationId`
 *
 * A sweep spans providers by construction; that is its entire purpose. The
 * proposals it reaches are organization-scoped and carry `sweep_id` back here,
 * so a provider reading their own case still sees that it was swept and why,
 * without this row being visible to them.
 */
@Entity('fleet_sweeps')
@Index('idx_fleet_sweeps_status', ['status', 'createdAt'])
export class FleetSweepEntity extends AbstractEntityWithoutSoftDelete {
  @Column({ name: 'opened_by_operator_id', type: 'uuid' })
  openedByOperatorId: string;

  /** The case that was decided first, and whose conclusion is being carried. */
  @Column({ name: 'source_proposal_id', type: 'uuid' })
  sourceProposalId: string;

  /** `OVERTURNED_PLATFORM_DEFECT` | `OVERTURNED_POLICY_DEFECT`. */
  @Column({ name: 'outcome', type: 'varchar', length: 40 })
  outcome: string;

  /**
   * What the affected proposals have in common — a binding version, a policy
   * version, a mapping revision. Matching is by this key over the time window,
   * not by similarity, so the set a sweep touched is reproducible from the row.
   */
  @Column({ name: 'defect_key', type: 'varchar', length: 128 })
  defectKey: string;

  @Column({ name: 'window_from', type: 'timestamptz' })
  windowFrom: Date;

  @Column({ name: 'window_to', type: 'timestamptz' })
  windowTo: Date;

  /** `OPEN` | `COMPLETED` | `FAILED`. */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'OPEN' })
  status: string;

  /**
   * How many proposals the key matched, and how many the sweep actually
   * changed.
   *
   * They differ legitimately: a matched proposal already `REVERSED`, or already
   * decided the same way, is counted and not re-applied. Reporting only one
   * number would make an idempotent re-run look like it did nothing.
   */
  @Column({ name: 'matched_count', type: 'int', default: 0 })
  matchedCount: number;

  @Column({ name: 'applied_count', type: 'int', default: 0 })
  appliedCount: number;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
