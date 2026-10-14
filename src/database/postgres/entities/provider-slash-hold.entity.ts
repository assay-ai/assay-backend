import { Column, Entity, Index } from 'typeorm';

import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * A provider's "slash hold" on one chain, as `EvmSlashHoldMonitor` last
 * evaluated it from the chain (`stakeOf`, `params()`) and the platform's own
 * upheld cases: while `held`, the provider's paid bindings are not routed or
 * quoted on that chain and no payment intent names it there.
 *
 * A cache of a decision derived from the chain, never on-chain state; one row
 * per provider and chain. Platform data, keyed by the provider's organization.
 */
@Entity('provider_slash_holds')
@Index('uq_provider_slash_holds_provider_chain', ['providerId', 'chainId'], { unique: true })
export class ProviderSlashHoldEntity extends AbstractEntityWithoutSoftDelete {
  /** The provider's organization id. */
  @Column({ name: 'provider_id', type: 'uuid' })
  providerId: string;

  /** CAIP-2. */
  @Column({ name: 'chain_id', type: 'varchar', length: 64 })
  chainId: string;

  @Column({ name: 'held', type: 'boolean', default: false })
  held: boolean;

  /** `SlashHoldReason` values that held at the last check; empty when none. */
  @Column({ name: 'reasons', type: 'jsonb', default: () => "'[]'::jsonb" })
  reasons: string[];

  /** Consecutive clear checks while still held (the release hysteresis). */
  @Column({ name: 'clear_checks', type: 'integer', default: 0 })
  clearChecks: number;

  @Column({ name: 'held_since', type: 'timestamptz', nullable: true })
  heldSince: Date | null;

  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt: Date | null;

  @Column({ name: 'checked_at', type: 'timestamptz', nullable: true })
  checkedAt: Date | null;
}
