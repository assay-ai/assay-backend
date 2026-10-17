import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One routing attempt the provider is accountable for. Append-only.
 *
 * Written by the router (`BindingAttemptRecorder`) for every attempt that
 * `attributeAttempt` counts, and only those: a `REQUEST_ERROR`, a self-call,
 * our own mapping fault or a timeout the request's budget cut short never
 * reach this table. It is the raw window behind `binding_stats`, pruned to the
 * last `BINDING_STATS_WINDOW_SIZE` rows per binding by the stats refresh.
 *
 * Platform data keyed by the provider's organization. Not tenant-scoped: a
 * binding's attempts come from every buying organization.
 */
@Entity('binding_attempts')
@Index('idx_binding_attempts_binding_created', ['bindingId', 'createdAt'])
@Index('idx_binding_attempts_provider_created', ['providerId', 'createdAt'])
export class BindingAttemptEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ name: 'binding_id', type: 'uuid' })
  bindingId: string;

  /** The provider's organization id. */
  @Column({ name: 'provider_id', type: 'uuid' })
  providerId: string;

  /** `FREE` or `PAID` (`RoutingCallClass`); `null` when the caller did not say. */
  @Column({ name: 'call_class', type: 'varchar', length: 8, nullable: true })
  callClass: string | null;

  /** `false` on a `SYSTEM_ERROR` the provider caused, timeouts included. */
  @Column({ name: 'available', type: 'boolean' })
  available: boolean;

  /** Wall-clock of the attempt; `null` when it is not a latency sample. */
  @Column({ name: 'latency_ms', type: 'int', nullable: true })
  latencyMs: number | null;

  /** The `ClassificationReason`, kept so a provider can be shown why. */
  @Column({ name: 'reason', type: 'varchar', length: 48 })
  reason: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
