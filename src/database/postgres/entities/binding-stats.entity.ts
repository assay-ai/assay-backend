import { Column, Entity, Index } from 'typeorm';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * One binding's observed window, as the stats refresh last computed it.
 *
 * Raw counts, not rates: the minimum sample size is applied when the row is
 * read (`deriveBindingStats`), so changing it needs no recompute, and a
 * provider-level figure can be pooled exactly by summing counts.
 *
 * Written only by `BindingStatsService.refresh` in the scheduler; read by
 * `DbProviderRegistry` on every routing decision. A cache of a derivation over
 * `binding_attempts` and `verification_records`, never a source of truth.
 */
@Entity('binding_stats')
@Index('uq_binding_stats_binding', ['bindingId'], { unique: true })
@Index('idx_binding_stats_provider', ['providerId'])
export class BindingStatsEntity extends AbstractEntityWithoutSoftDelete {
  @Column({ name: 'binding_id', type: 'uuid' })
  bindingId: string;

  /** The provider's organization id. */
  @Column({ name: 'provider_id', type: 'uuid' })
  providerId: string;

  /** Attempts in the window. */
  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  /** Of those, the ones with no provider-caused `SYSTEM_ERROR`. */
  @Column({ name: 'available_attempts', type: 'int', default: 0 })
  availableAttempts: number;

  /** Of those, the ones that carried a latency. */
  @Column({ name: 'latency_samples', type: 'int', default: 0 })
  latencySamples: number;

  @Column({ name: 'p50_latency_ms', type: 'int', nullable: true })
  p50LatencyMs: number | null;

  @Column({ name: 'p95_latency_ms', type: 'int', nullable: true })
  p95LatencyMs: number | null;

  /** Quality-bearing verdicts (`PASS`/`FAIL`) in the window. */
  @Column({ name: 'verdicts', type: 'int', default: 0 })
  verdicts: number;

  @Column({ name: 'passed_verdicts', type: 'int', default: 0 })
  passedVerdicts: number;

  @Column({ name: 'refreshed_at', type: 'timestamptz' })
  refreshedAt: Date;
}
