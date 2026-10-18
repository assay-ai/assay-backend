import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { AccessMode } from '@modules/toolset/domain/access';

/**
 * The consent API's shapes (spec §6.3.5). Nothing here ever carries a code,
 * a token, a PKCE challenge, the client's `state` or its redirect URI: the
 * page needs none of them, and the code never passes through `{WEB}`
 * JavaScript.
 */

/** `credential_name varchar(128)`, as an API key's name. */
export const OAUTH_CREDENTIAL_NAME_MAX = 128;

export class ApproveOAuthRequestBodyDto {
  @ApiProperty({ description: 'The agent the app will act as; one of `agents[].id`' })
  @IsUUID()
  agentId: string;

  @ApiProperty({
    description: 'The connection’s name, as shown in Agents & keys',
    example: 'Claude Code · 2026-10-19',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(OAUTH_CREDENTIAL_NAME_MAX)
  name: string;
}

export class OAuthRedirectDto {
  @ApiProperty({
    description: '`{MCP}/oauth/authorize/continue?request=…`: where the page navigates next',
  })
  redirectTo: string;
}

export class OAuthConsentClientDto {
  @ApiProperty({
    description: 'The vendor’s listed name when verified, else the self-declared one',
  })
  name: string;

  @ApiProperty({ enum: OAuthClientKind })
  kind: OAuthClientKind;

  @ApiProperty({
    nullable: true,
    description: 'eTLD+1 of the client metadata host, punycode; `null` when none is proven',
  })
  registrableDomain: string | null;

  @ApiProperty({ nullable: true })
  host: string | null;

  @ApiProperty()
  verified: boolean;

  @ApiProperty()
  builtin: boolean;

  @ApiProperty({ description: 'Its grants may bind a payment key (only the Assay app)' })
  paymentClient: boolean;
}

export class OAuthConsentReturnToDto {
  @ApiProperty({ enum: ['WEB', 'LOCAL_APP'] })
  kind: 'WEB' | 'LOCAL_APP';

  @ApiProperty()
  display: string;
}

export class OAuthConsentLimitsDto {
  @ApiProperty({ type: MoneyDto, nullable: true, description: '`null` = no ceiling' })
  perCall: MoneyDto | null;

  @ApiProperty({ type: MoneyDto, nullable: true, description: '`null` = no ceiling' })
  perDay: MoneyDto | null;

  @ApiProperty()
  freeCallsPerDay: number;
}

export class OAuthConsentAccessDto {
  @ApiProperty({ enum: AccessMode })
  mode: AccessMode;

  @ApiProperty({ example: 'All tools' })
  summary: string;
}

export class OAuthConsentAgentDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ nullable: true })
  label: string | null;

  @ApiProperty({ description: 'Agent and organization active, wallet linked' })
  active: boolean;

  @ApiProperty({ type: OAuthConsentLimitsDto })
  limits: OAuthConsentLimitsDto;

  @ApiProperty({ type: OAuthConsentAccessDto })
  access: OAuthConsentAccessDto;

  @ApiProperty({ description: 'Live OAuth connections; the page warns from 45, the cap is 50' })
  liveOAuthCredentials: number;
}

export class OAuthConsentReplacesDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: 'It has its own tool narrowing, which the new connection keeps' })
  narrowed: boolean;
}

export class OAuthConsentRequestDto {
  @ApiProperty()
  requestId: string;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  expiresAt: string;

  @ApiProperty({ type: OAuthConsentClientDto })
  client: OAuthConsentClientDto;

  @ApiProperty({ type: OAuthConsentReturnToDto })
  returnTo: OAuthConsentReturnToDto;

  @ApiProperty({ type: [String] })
  scope: string[];

  @ApiProperty({ type: [OAuthConsentAgentDto] })
  agents: OAuthConsentAgentDto[];

  @ApiPropertyOptional({
    type: OAuthConsentReplacesDto,
    description: 'Present only for a sign-in of the Assay app replacing its own earlier one',
  })
  replaces?: OAuthConsentReplacesDto;

  @ApiProperty()
  suggestedName: string;
}
