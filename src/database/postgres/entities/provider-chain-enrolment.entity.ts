import { Column, Entity, Index } from 'typeorm';

import { PayoutProof } from '@modules/provider/ports/provider-registration.types';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One provider identity, N chain enrolments.
 *
 * ## What this row is, and what stays on `providers`
 *
 * `providers` holds what is a fact about BEHAVIOUR — tier, stats, SLA windows,
 * strikes, disputes, the verification profile. Those describe a *service*, and
 * the service is one service however many chains it takes money on. This row
 * holds what is a fact about MONEY ON A CHAIN: the payout address, the proof
 * that the provider controls it, and the stake authority whose collateral a
 * slash reaches into.
 *
 * Splitting the identity instead would fork the reputation with it, and the
 * outcome is exactly this: a provider slashed on one chain would enrol on the
 * other with a clean record and keep routing. One `providers` row, N of these.
 *
 * ## The row exists before the stake
 *
 * {@link stakeAuthorityAccountId} is nullable and that is deliberate, not an
 * accommodation. A provider enrols by proving a payout address; naming the
 * wallet the collateral will sit in is a separate act with a separate
 * signature. `null` here means "declared this chain, not yet funded" — a state
 * that must be representable, because the payout address has to live somewhere
 * during it. Staking never creates one of these rows; it fills in three columns
 * on a row that already existed.
 *
 * ## Keyed on `organization_id`
 *
 * Not a foreign key to `providers.id`. `providerId === organizationId`
 * platform-wide — `tool_bindings` has no `provider_id` column at all — so a key
 * on `providers.id` could not be joined to a binding without a second lookup.
 * `uq_providers_organization_id` makes the two exactly as strong.
 *
 * ## No soft delete
 *
 * The same rule `providers` and `payment_intents` follow: this row is the
 * record of where a provider's earnings were sent and whose collateral was
 * slashable while they served traffic. A deleted one is a reconciliation hole,
 * and it would also keep occupying `uq_provider_chain_enrolments_org_chain`,
 * so the re-enrolment the caller was trying to perform would be refused by a
 * row they believe they deleted. Leaving a chain is {@link status}, not a
 * delete.
 */
@Entity('provider_chain_enrolments')
@Index('idx_provider_chain_enrolments_chain_status', ['chainId', 'status'])
export class ProviderChainEnrolmentEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /**
   * CAIP-2. The chain this enrolment is about.
   *
   * `chk_provider_chain_enrolments_chain_caip2` holds it to the grammar
   * `caip.types.ts` parses, and `uq_provider_chain_enrolments_org_chain` makes
   * (organization, chain) the identity of the row: one enrolment per provider
   * per chain, decided by Postgres rather than by a read-then-write.
   */
  @Column({ name: 'chain_id', type: 'varchar', length: 128 })
  chainId: string;

  /**
   * CAIP-10, on {@link chainId}, and only ever written together with
   * {@link payoutProof}.
   *
   * `NOT NULL` — unlike `providers.payout_account_id`, which is null for every
   * provider who has not proved one. Here the address is the *reason the row
   * exists*: an enrolment without one would be a declaration of intent with
   * nowhere to send the money, and the router would have to carry a case for it
   * that means nothing.
   *
   * `chk_provider_chain_enrolments_payout_on_chain` is the constraint that
   * matters most: the address must start with this row's own `chain_id`. It is
   * what stops a mainnet address being filed under devnet, where the first
   * symptom would be a payout to an account that does not exist.
   */
  @Column({ name: 'payout_account_id', type: 'varchar', length: 256 })
  payoutAccountId: string;

  /** The signature that proved {@link payoutAccountId}. The payout-proof envelope. */
  @Column({ name: 'payout_proof', type: 'jsonb' })
  payoutProof: PayoutProof;

  @Column({ name: 'payout_proved_at', type: 'timestamptz' })
  payoutProvedAt: Date;

  /**
   * CAIP-10, on {@link chainId}. Null until a signature proved one.
   *
   * Null is the ordinary state, not an edge case — see the class comment. The
   * trio {@link stakeAuthorityAccountId} / {@link stakeProof} /
   * {@link stakeProvedAt} is all-or-nothing
   * (`chk_provider_chain_enrolments_stake_proved_together`), for the reason
   * `providers` has the same rule: an unproved stake authority names *someone
   * else's* collateral as the thing to slash.
   *
   * `uq_provider_chain_enrolments_stake_authority` — UNIQUE WHERE NOT NULL — is
   * `uq_providers_stake_authority` moved here. Two providers naming one stake
   * account is one pool of capital clearing the gate twice. Partial, because
   * null is the common state.
   */
  @Column({ name: 'stake_authority_account_id', type: 'varchar', length: 256, nullable: true })
  stakeAuthorityAccountId: string | null;

  /** Written in the same statement as {@link stakeAuthorityAccountId}, or not at all. */
  @Column({ name: 'stake_proof', type: 'jsonb', nullable: true })
  stakeProof: PayoutProof | null;

  @Column({ name: 'stake_proved_at', type: 'timestamptz', nullable: true })
  stakeProvedAt: Date | null;

  /**
   * `ACTIVE` | `SUSPENDED` | `UNBONDING` — `ChainEnrolmentStatus`.
   *
   * The enrolment's lifecycle, which is not the provider's. The backfill seeds
   * it from `providers.status` so the two agree on day one; from the first
   * per-chain suspension onwards they are independent, which is the whole point
   * of the table.
   */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'ACTIVE' })
  status: string;

  /**
   * When the provider declared this chain.
   *
   * Distinct from `created_at`: the backfill sets this to the moment the payout
   * address was *proved*, which for every pre-existing provider is well before
   * the row was written. `created_at` records when this table learned about the
   * enrolment; this column records when the enrolment happened.
   */
  @Column({ name: 'enrolled_at', type: 'timestamptz' })
  enrolledAt: Date;
}
