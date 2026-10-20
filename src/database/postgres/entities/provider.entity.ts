import { Column, Entity, Index } from 'typeorm';

import {
  AcceptedTerms,
  ProviderContact,
  ProviderVerificationCheck,
} from '@modules/provider/ports/provider-registration.types';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * The provider, as a counterparty rather than as a routing weight.
 *
 * ## Registration is open, and the schema is where that is true
 *
 * There is no `PENDING`, no `APPROVED`, no `reviewed_by`. A row exists because
 * somebody registered, and it is `ACTIVE` from that moment. The absence is the
 * feature: an approval column with nothing writing to it is an approval step
 * waiting for someone to switch on, and anyone who registers is in. What still
 * gates *paid traffic* is the publish check — a green mapping tester and stake
 * at or above the minimum — and neither of those is a human reading an
 * application.
 *
 * ## One organization, one provider
 *
 * `organization_id` is `UNIQUE`, not merely indexed. `ProviderProfileService`
 * has always treated the calling organization's id as its provider id; until
 * now that was a convention with no row to point at, and two rows for one
 * organization would have made "the provider record for this org" ambiguous at
 * exactly the endpoints that spend money. The constraint is also what makes
 * registration idempotent to reason about: a second `POST` is a `409`, decided
 * by Postgres rather than by a read-then-write that two requests can interleave.
 *
 * ## No soft delete
 *
 * `WithoutSoftDelete`, for the reason `payment_intents` has none: this row is
 * the identity behind every payout sent and every stake slashed. A soft-deleted
 * provider would also keep occupying the unique constraint, so the delete a
 * caller *thinks* they did would block the re-registration they are trying to
 * perform — a failure mode that only shows up on the day someone needs it.
 *
 * ## The payout address is NOT here — it is on the enrolment
 *
 * `payout_account_id`, `payout_proof` and `payout_proved_at` lived on this row
 * until multichain support and were dropped by
 * `1759300000002-drop-provider-payout-columns`. They are now
 * `provider_chain_enrolments`' columns, one row per chain, because a provider
 * has one answer *per chain* to "where do I get paid" and a single column could
 * only ever hold one of them. Leaving them here as well would give one provider
 * two answers, which is the shape that hands an attacker somebody else's money.
 *
 * The rule they encoded survives the move intact: an address that has not been
 * proved is not persisted anywhere — there is deliberately no "declared" column
 * for one, on this row or on the enrolment — so no future code path can read an
 * unproved address and pay to it.
 *
 * ## The stake authority is NOT here either — it is on the enrolment
 *
 * `stake_authority`, `stake_proof` and `stake_proved_at` were dropped by
 * `1759300000003-drop-provider-stake-authority-columns`, for the
 * same reason and one that is sharper. A slash is executed by the settlement
 * contract of the chain the call was paid on, and that contract can neither see
 * nor take an account on another chain — so "the account whose collateral backs
 * this provider" has one answer PER CHAIN, and a single column had to be wrong
 * about one of them. `uq_providers_stake_authority`,
 * `chk_providers_stake_authority_caip10` and
 * `chk_providers_stake_proved_together` went with them; their equivalents are
 * `uq_provider_chain_enrolments_stake_authority`,
 * `chk_provider_chain_enrolments_stake_caip10` (plus `..._stake_on_chain`,
 * which the old column had no way to express) and
 * `chk_provider_chain_enrolments_stake_proved_together`.
 *
 * The rule survives the move: an unproved payout address loses *this*
 * provider's money, while an unproved stake authority names *someone else's*
 * collateral as the thing to slash — so neither is persisted before a signature
 * proves it, on the enrolment as it was here.
 */
@Entity('providers')
@Index('idx_providers_verified', ['verified'])
export class ProviderEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /** Legal or trading name. */
  @Column({ name: 'legal_name', type: 'varchar', length: 200 })
  legalName: string;

  /**
   * Webhooks, incidents, binding changes.
   *
   * `jsonb` rather than three flat columns because a contact is one object with
   * one lifetime — it is replaced whole, never field by field — and because the
   * pair of them are validated against each other (registration requires
   * distinct inboxes). Flattening would spread one invariant across six
   * columns.
   */
  @Column({ name: 'technical_contact', type: 'jsonb' })
  technicalContact: ProviderContact;

  /** Escalation. Enforced distinct from {@link technicalContact} — see the DTO. */
  @Column({ name: 'owner_contact', type: 'jsonb' })
  ownerContact: ProviderContact;

  /** IANA zone name. Every deadline the platform quotes is counted here. */
  @Column({ name: 'timezone', type: 'varchar', length: 64 })
  timezone: string;

  /** Which text of which three documents, and when. See `AcceptedTerms`. */
  @Column({ name: 'accepted_terms', type: 'jsonb' })
  acceptedTerms: AcceptedTerms;

  /** `ACTIVE` | `SUSPENDED` | `UNBONDING` — `ProviderStatus`. Never `PENDING`. */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'ACTIVE' })
  status: string;

  /** `NEW` | `ESTABLISHED` | `TRUSTED` — `ProviderTier`. Earned, never chosen. */
  @Column({ name: 'tier', type: 'varchar', length: 16, default: 'NEW' })
  tier: string;

  /**
   * The endpoint the connectivity check probes at registration.
   *
   * Not the binding's endpoint — that is set in the binding editor, per
   * binding, and a provider may end up serving several. This is the one they
   * name during setup so the connectivity check has something to dial and so
   * the allowlist conversation happens before they go live rather than after.
   */
  @Column({ name: 'endpoint', type: 'varchar', length: 2048, nullable: true })
  endpoint: string | null;

  /**
   * The `verified` label. Informational, and read by nothing that decides anything.
   *
   * Indexed because the catalogue filters on it for buyers, which is the entire
   * point of the label existing.
   */
  @Column({ name: 'verified', type: 'boolean', default: false })
  verified: boolean;

  @Column({ name: 'verified_by', type: 'varchar', length: 200, nullable: true })
  verifiedBy: string | null;

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  /** `DOCUMENT_REVIEW`, `DOMAIN_CONTROL`, `PARTNER_ATTESTATION`, … */
  @Column({ name: 'verification_method', type: 'varchar', length: 64, nullable: true })
  verificationMethod: string | null;

  /**
   * What was checked, one entry per finding.
   *
   * A `verified` row with an empty list is the shape this column exists to
   * prevent: a label whose author claimed everything and named nothing.
   */
  @Column({ name: 'verification_checks', type: 'jsonb', default: () => `'[]'::jsonb` })
  verificationChecks: ProviderVerificationCheck[];

  /** When the label lapses. Null means it does not. */
  @Column({ name: 'verification_expires_at', type: 'timestamptz', nullable: true })
  verificationExpiresAt: Date | null;

  @Column({ name: 'verification_evidence_url', type: 'varchar', length: 2048, nullable: true })
  verificationEvidenceUrl: string | null;
}
