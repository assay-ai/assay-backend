import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { ProviderConnectivityCheckEntity } from '@database/postgres/entities/provider-connectivity-check.entity';

import { ConnectivityOutcome } from '../ports/provider-registration.types';

/**
 * The response shapes shared by the registration surface, the verified label
 * and the connectivity check.
 *
 * They live in one file rather than three because all three are read off the
 * same row and rendered on the same onboarding screen.
 * Three copies of `ProviderContactDto` would be three chances for the console
 * to receive a differently-shaped contact depending on which endpoint answered.
 */

/**
 * A contact, on the wire.
 *
 * Typed, not free text — that is the whole point. See `ProviderContact` in
 * `ports/provider-registration.types.ts` for why a mailbox string alone fails
 * the requirement it is meant to satisfy.
 */
export class ProviderContactDto {
  @ApiProperty({ example: 'Alex Example', description: 'The human. Not a role alias.' })
  name: string;

  @ApiProperty({ example: 'alex@vesseldata.example' })
  email: string;

  @ApiPropertyOptional({ nullable: true, description: 'Second channel for what email loses.' })
  phone: string | null;
}

/** Which text of which document was accepted, and by whom. */
export class AcceptedTermsDto {
  @ApiProperty({ example: 'v1.0' })
  providerAgreementVersion: string;

  @ApiProperty({ example: 'v1.0' })
  payoutTermsVersion: string;

  @ApiProperty({ example: 'v1.0' })
  slashPolicyVersion: string;

  @ApiProperty({ description: 'ISO-8601, UTC' })
  acceptedAt: string;

  @ApiProperty({ description: 'The console credential that accepted' })
  acceptedBy: string;
}

/** One named finding inside a verification profile. */
export class ProviderVerificationCheckDto {
  @ApiProperty({ example: 'LEGAL_ENTITY' })
  check: string;

  @ApiProperty({ enum: ['PASS', 'FAIL', 'NOT_CHECKED'] })
  result: 'PASS' | 'FAIL' | 'NOT_CHECKED';

  @ApiPropertyOptional({ nullable: true })
  note: string | null;
}

/**
 * The `verified` label on the wire — the label, its author, and what they looked at.
 *
 * Served to buyers through the catalogue and to the provider through their own
 * registration record. It gates nothing: registration is open and
 * publishing is gated by the mapping tester and stake, neither of which reads
 * this. A client that treats `verified: false` as "cannot be used" has invented
 * an approval step the platform does not have.
 */
export class ProviderVerificationDto {
  @ApiProperty({ description: 'Informational. Not a gate on registration or on publishing.' })
  verified: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'Who checked. Null iff not verified.' })
  verifiedBy: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'ISO-8601, UTC. Null iff not verified.' })
  verifiedAt: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'DOCUMENT_REVIEW' })
  method: string | null;

  @ApiProperty({ type: [ProviderVerificationCheckDto], description: 'What was actually checked.' })
  checks: ProviderVerificationCheckDto[];

  @ApiPropertyOptional({ nullable: true, description: 'When the label lapses. Null: it does not.' })
  expiresAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  evidenceUrl: string | null;
}

/**
 * One connectivity probe on the wire.
 *
 * `outcome` is three-valued on purpose. `BLOCKED` means the egress guard
 * refused to dial — a private, loopback, link-local or metadata address, or a
 * scheme we do not speak — and telling that provider "we could not reach you"
 * would be true and useless.
 */
export class ConnectivityCheckResultDto {
  @ApiProperty({ enum: ConnectivityOutcome })
  outcome: ConnectivityOutcome;

  @ApiProperty()
  endpoint: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Whatever answered, including 4xx. A 401 is a pass: it proves DNS, TLS and a listener, ' +
      'which is all this check claims.',
  })
  statusCode: number | null;

  @ApiPropertyOptional({ nullable: true })
  latencyMs: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'EgressFailureKind, when there was one' })
  failureKind: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'EGRESS_* code, when there was one' })
  failureCode: string | null;

  @ApiPropertyOptional({ nullable: true })
  detail: string | null;

  @ApiProperty({ description: 'ISO-8601, UTC' })
  checkedAt: string;
}

// ── Mappers ────────────────────────────────────────────────────────────────
//
// Entity → DTO in one place, so the registration surface, the catalogue and
// the connectivity endpoint cannot disagree about what a contact or a label
// looks like.

export function toContactDto(contact: {
  name: string;
  email: string;
  phone?: string | null;
}): ProviderContactDto {
  return { name: contact.name, email: contact.email, phone: contact.phone ?? null };
}

/**
 * The label, assembled from the row.
 *
 * `verifiedBy` and `verifiedAt` are non-null exactly when `verified` is true —
 * the database refuses the other combination
 * (`chk_providers_verified_attributed`), so this mapper does not have to invent
 * a fallback author for a flag with no provenance.
 */
export function toVerificationDto(provider: ProviderEntity): ProviderVerificationDto {
  return {
    verified: provider.verified,
    verifiedBy: provider.verifiedBy ?? null,
    verifiedAt: provider.verifiedAt ? provider.verifiedAt.toISOString() : null,
    method: provider.verificationMethod ?? null,
    checks: (provider.verificationChecks ?? []).map((check) => ({
      check: check.check,
      result: check.result,
      note: check.note ?? null,
    })),
    expiresAt: provider.verificationExpiresAt ? provider.verificationExpiresAt.toISOString() : null,
    evidenceUrl: provider.verificationEvidenceUrl ?? null,
  };
}

export function toConnectivityDto(
  check: ProviderConnectivityCheckEntity,
): ConnectivityCheckResultDto {
  return {
    outcome: check.outcome as ConnectivityOutcome,
    endpoint: check.endpoint,
    statusCode: check.statusCode ?? null,
    latencyMs: check.latencyMs ?? null,
    failureKind: check.failureKind ?? null,
    failureCode: check.failureCode ?? null,
    detail: check.detail ?? null,
    checkedAt: check.createdAt.toISOString(),
  };
}
