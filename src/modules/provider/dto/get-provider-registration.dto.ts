import { Type } from 'class-transformer';
import { IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { OnboardingStepStatus } from '../ports/provider-registration.types';
import { ConnectivityCheckResultDto } from './provider-shared.dto';
import {
  AcceptedTermsInputDto,
  ProviderContactInputDto,
  ProviderRegistrationRecordDto,
} from './register-provider.dto';

/**
 * The four onboarding steps, in display order.
 *
 * `ACCOUNT` and `TERMS` are this module's; `PAYOUT_WALLET` belongs to the
 * payout proof and `ENDPOINT` to the connectivity check. All four are reported
 * here because the screen renders one step counter across all four — a
 * provider mid-setup reads "step 2 of 4" regardless of which flow owns the step
 * they are stuck on.
 */
export enum ProviderOnboardingStepKey {
  ACCOUNT = 'account',
  PAYOUT_WALLET = 'payoutWallet',
  ENDPOINT = 'endpoint',
  TERMS = 'terms',
}

/** One row of the onboarding step list. */
export class ProviderOnboardingStepDto {
  @ApiProperty({ enum: ProviderOnboardingStepKey })
  key: ProviderOnboardingStepKey;

  @ApiProperty({ example: 'Payout wallet' })
  title: string;

  @ApiProperty({ example: 'who we contact, and in which timezone' })
  caption: string;

  @ApiProperty({ enum: OnboardingStepStatus })
  status: OnboardingStepStatus;
}

/** One row of the commercial-terms table (onboarding step 4). */
export class ProviderCommercialTermDto {
  @ApiProperty({ example: 'takeRate' })
  key: string;

  @ApiProperty({ example: 'Take rate' })
  label: string;

  @ApiProperty({ example: '10%' })
  value: string;

  @ApiProperty({ example: 'flat, no per-call fee floor' })
  caption: string;
}

/** The published terms, as `provider-terms.ts` computed them at request time. */
export class ProviderTermsSummaryDto {
  @ApiProperty({ example: 'v1.0' })
  providerAgreementVersion: string;

  @ApiProperty({ example: 'v1.0' })
  payoutTermsVersion: string;

  @ApiProperty({ example: 'v1.0' })
  slashPolicyVersion: string;

  @ApiProperty({
    example:
      'I accept the provider agreement v1.0, the payout terms v1.0 and the slash policy v1.0',
  })
  acceptanceLine: string;

  @ApiProperty({ type: [ProviderCommercialTermDto] })
  commercialTerms: ProviderCommercialTermDto[];
}

/**
 * `GET /providers/me/registration` and `PATCH /providers/me/registration` —
 * the whole onboarding state the console renders in one call, rather than
 * four (one per step) or a client stitching the row, the terms and the last
 * connectivity check together itself.
 */
export class GetProviderRegistrationResponseDto {
  @ApiProperty({ type: ProviderRegistrationRecordDto })
  registration: ProviderRegistrationRecordDto;

  @ApiProperty({ type: [ProviderOnboardingStepDto] })
  steps: ProviderOnboardingStepDto[];

  @ApiProperty({
    description:
      'The ordinal (1-based) of the first non-DONE step, or `totalSteps` when every step is DONE.',
  })
  currentStep: number;

  @ApiProperty({ example: 4 })
  totalSteps: number;

  @ApiProperty({ type: ProviderTermsSummaryDto })
  terms: ProviderTermsSummaryDto;

  @ApiPropertyOptional({
    type: ConnectivityCheckResultDto,
    nullable: true,
    description:
      'The latest probe of any endpoint this provider has declared. Null before the first.',
  })
  lastConnectivityCheck: ConnectivityCheckResultDto | null;
}

/**
 * `PATCH /providers/me/registration` request body.
 *
 * `endpoint` and the payout address have no field here, on purpose — see
 * `RegisterProviderBodyDto`'s comment; the reason is identical. Since multichain
 * support the address is not even a column on the row this patch writes. Every field is
 * optional because a caller updating only `legalName` should not have to
 * resend contacts and timezone unchanged.
 *
 * `acceptedTerms` is how a provider re-accepts once the published versions
 * move: send the new versions, and the service re-validates and re-stamps
 * `acceptedAt`/`acceptedBy` exactly as `POST /providers` does. Omit it and the
 * row's existing acceptance is left untouched — a legal-name edit is not
 * itself a re-acceptance of anything.
 */
export class UpdateProviderAccountBodyDto {
  @ApiPropertyOptional({ example: 'Example Vessel Data Ltd' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  legalName?: string;

  @ApiPropertyOptional({ type: ProviderContactInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProviderContactInputDto)
  technicalContact?: ProviderContactInputDto;

  @ApiPropertyOptional({ type: ProviderContactInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProviderContactInputDto)
  ownerContact?: ProviderContactInputDto;

  @ApiPropertyOptional({ example: 'Europe/Oslo' })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({ type: AcceptedTermsInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AcceptedTermsInputDto)
  acceptedTerms?: AcceptedTermsInputDto;
}
