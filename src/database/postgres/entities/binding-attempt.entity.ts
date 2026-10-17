import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One routing attempt the provider is accountable for. Append-only.
 *
 * Written by the router (`BindingAttemptRecorder`) for every attempt that
 * `attributeAttempt` counts, and only those: a `REQUEST_ERROR`, a self-call,
 * our own mapping fault, an unrecognised throw, a free call or a timeout the
 * request's budget cut short never reach this table. It is the raw window
 * behind `binding_stats`, pruned by the stats refresh to each buyer's last
 * `BINDING_STATS_MAX_PER_BUYER` rows per binding, none older than 7 days.
 *
 * Platform data keyed by the provider's organization. Not tenant-scoped: a
 * binding's attempts come from every buying organization.
 */
@Entity('binding_attempts')
@Index('idx_binding_attempts_binding_created', ['bindingId', 'createdAt'])
@Index('idx_binding_attempts_binding_buyer_created', [
  'bindingId',
  'buyerOrganizationId',
  'createdAt',
])
@Index('idx_binding_attempts_provider_created', ['providerId', 'createdAt'])
export class BindingAttemptEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ name: 'binding_id', type: 'uuid' })
  bindingId: string;

  /** The provider's organization id. */
  @Column({ name: 'provider_id', type: 'uuid' })
  providerId: string;

  /** Who paid for the call. The refresh caps each buyer's share of the window. */
  @Column({ name: 'buyer_organization_id', type: 'uuid' })
  buyerOrganizationId: string;

  /** `PAID` — the only class recorded today (`attributeAttempt`). */
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
