import { Type } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ChainEnrolmentStatus } from '../ports/chain-enrolment.port';
import { ProviderStatus, ProviderTier } from '../ports/provider.types';
import {
  AcceptedTermsDto,
  ProviderContactDto,
  ProviderVerificationDto,
} from './provider-shared.dto';

/**
 * `POST /providers` — open registration.
 *
 * A person, on the wire, and validated as one — see `ProviderContact` in
 * `ports/provider-registration.types.ts` for why a free-text string is not an
 * acceptable substitute. This class is the input twin of
 * `ProviderContactDto`: that one renders a contact that is already on a row,
 * this one is what `class-validator` checks before one gets there.
 */
export class ProviderContactInputDto {
  @ApiProperty({ example: 'Alex Example', description: 'The human. Not a role alias.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: 'alex@vesseldata.example' })
  @IsEmail()
  @MaxLength(320)
  email: string;

  @ApiPropertyOptional({ nullable: true, description: 'Second channel for what email loses.' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string | null;
}

/**
 * The three document versions a caller claims to accept.
 *
 * No `acceptedAt`/`acceptedBy` here — those are not something a client gets to
 * assert about itself. `acceptedAt` is `now()` at the moment the service
 * writes the row and `acceptedBy` is `session.credentialId`, the console
 * credential that presented the bearer token; see `ProviderRegistrationService`.
 */
export class AcceptedTermsInputDto {
  @ApiProperty({ example: 'v1.0', description: 'Must equal the currently published version.' })
  @IsString()
  @IsNotEmpty()
  providerAgreementVersion: string;

  @ApiProperty({ example: 'v1.0', description: 'Must equal the currently published version.' })
  @IsString()
  @IsNotEmpty()
  payoutTermsVersion: string;

  @ApiProperty({ example: 'v1.0', description: 'Must equal the currently published version.' })
  @IsString()
  @IsNotEmpty()
  slashPolicyVersion: string;
}

/**
 * `POST /providers` request body.
 *
 * `endpoint` and the payout address are deliberately absent — they are the
 * connectivity check's and the payout proof's, respectively, proved through
 * their own flows rather than declared here. A registration body that accepted
 * either would let a caller claim a payout address with no signature behind it,
 * which is exactly what `provider_chain_enrolments.payout_proof` exists to make
 * impossible.
 */
export class RegisterProviderBodyDto {
  @ApiProperty({ example: 'Example Vessel Data Ltd', description: 'Legal or trading name.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName: string;

  @ApiProperty({
    type: ProviderContactInputDto,
    description: 'Webhooks, incidents, binding changes.',
  })
  @ValidateNested()
  @Type(() => ProviderContactInputDto)
  technicalContact: ProviderContactInputDto;

  @ApiPropertyOptional({
    type: ProviderContactInputDto,
    nullable: true,
    description:
      'The second contact, for escalations — must not be the same inbox as ' +
      '`technicalContact`. Optional here: it is required before a PAID listing is ' +
      'published (`SECOND_CONTACT`, code `PROVIDER_SECOND_CONTACT_REQUIRED`), and is ' +
      'added later with `PATCH /providers/me/registration`.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProviderContactInputDto)
  ownerContact?: ProviderContactInputDto | null;

  @ApiProperty({
    example: 'Europe/Oslo',
    description: 'An IANA zone name. Every deadline the platform quotes is counted here.',
  })
  @IsString()
  @IsNotEmpty()
  timezone: string;

  @ApiProperty({ type: AcceptedTermsInputDto })
  @ValidateNested()
  @Type(() => AcceptedTermsInputDto)
  acceptedTerms: AcceptedTermsInputDto;
}

/**
 * One chain this provider is enrolled on, and the address proved for it.
 *
 * Carries {@link status}, and that is not decoration: without it a closed
 * enrolment renders identically to a live one, so a provider whose only chain
 * has been withdrawn reads their own address off the screen while every paid
 * binding they own is refused. The address answers "where", the status answers
 * "whether" — and the second is the half that decides if money arrives.
 *
 * A **list**, never a single field. The rule that a per-chain quantity is
 * never presented to a human as one value applies to addresses for exactly the
 * reason it applies to balances: collapsing two chains' answers into one makes
 * the console show a number — here, an address — that is true on one chain and
 * false on the other, with nothing on screen saying which. A provider paid on
 * Solana and on `eip155:4663` has two payout addresses and has to be able to
 * read both of them.
 */
export class ProviderPayoutAccountDto {
  @ApiProperty({ example: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', description: 'CAIP-2.' })
  chainId: string;

  @ApiProperty({ description: 'CAIP-10, on `chainId`. Proved by a signature.' })
  accountId: string;

  @ApiProperty({ description: 'ISO-8601, UTC — when the signature proved it.' })
  provedAt: string;

  @ApiProperty({
    enum: ChainEnrolmentStatus,
    description:
      "The ENROLMENT's lifecycle on this chain, which is not the provider's. Only `ACTIVE` is " +
      'payable: `evaluatePayoutGate` refuses every paid binding on a chain whose enrolment is ' +
      '`SUSPENDED` or `UNBONDING`, even though the address below is proved.',
  })
  status: ChainEnrolmentStatus;
}

/**
 * The registration record, on the wire.
 *
 * Shared by `POST /providers`'s response and by the `registration` field of
 * `GET /providers/me/registration` / `PATCH /providers/me/registration`
 * (`get-provider-registration.dto.ts`) — one shape for "the row", read
 * wherever it is read, so the console cannot receive a differently-shaped
 * provider depending on which endpoint answered.
 */
export class ProviderRegistrationRecordDto {
  @ApiProperty()
  id: string;

  @ApiProperty({
    description:
      'Your provider id: the audience (`aud`) every Assay request signature to your endpoints ' +
      'is made for. Set it as `provider` in your verifier so it refuses requests Assay signed ' +
      'for anyone else. It is your organization id.',
  })
  providerId: string;

  @ApiProperty({ example: 'Example Vessel Data Ltd' })
  legalName: string;

  @ApiProperty({ type: ProviderContactDto })
  technicalContact: ProviderContactDto;

  @ApiPropertyOptional({
    type: ProviderContactDto,
    nullable: true,
    description:
      'The second contact. Null until added; required before a PAID listing is published.',
  })
  ownerContact: ProviderContactDto | null;

  @ApiProperty({ example: 'Europe/Oslo' })
  timezone: string;

  @ApiProperty({ type: AcceptedTermsDto })
  acceptedTerms: AcceptedTermsDto;

  @ApiProperty({
    enum: ProviderStatus,
    description: 'Always `ACTIVE` on the row registration writes — there is no `PENDING`.',
  })
  status: ProviderStatus;

  @ApiProperty({
    enum: ProviderTier,
    description: 'Always `NEW` at registration. Earned, never chosen.',
  })
  tier: ProviderTier;

  @ApiProperty({
    type: [ProviderPayoutAccountDto],
    description:
      'One entry per chain this provider has proved an address on. Empty until ' +
      'a wallet signature proves the first. Never collapsed to a single address — see the DTO.',
  })
  payoutAccounts: ProviderPayoutAccountDto[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'The endpoint the connectivity check probes. Null until declared.',
  })
  endpoint: string | null;

  @ApiProperty({ type: ProviderVerificationDto })
  verification: ProviderVerificationDto;

  @ApiProperty({ description: 'ISO-8601, UTC' })
  registeredAt: string;
}

/**
 * `POST /providers` response — `201`.
 *
 * Open registration: this is the entire response. There is no follow-up
 * "pending approval" state and nothing else has to happen before the row is
 * real — see `provider.entity.ts`'s class comment and `ProviderRegistrationService`.
 */
export class RegisterProviderResponseDto extends ProviderRegistrationRecordDto {}
