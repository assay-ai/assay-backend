import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { AGENT_SCOPES, AgentScope, DEFAULT_AGENT_SCOPES } from '@shared/auth/agent-scope';

import {
  CREDENTIAL_DEFAULT_LIFETIME_DAYS,
  CREDENTIAL_MAX_LIFETIME_DAYS,
} from '../constants/credential-expiry.constants';

export class CreateAgentCredentialBodyDto {
  @ApiProperty({ description: 'Human label — "CI deploy", "local dev"', example: 'CI deploy' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name: string;

  @ApiPropertyOptional({
    enum: AgentScope,
    isArray: true,
    example: DEFAULT_AGENT_SCOPES,
    description:
      'What the key may do. Omitted: `tools:call payments activity:read`. ' +
      '`payments` needs `tools:call`. `reports:write` is never on unless asked for. ' +
      'A route not open to any scope (audit log, notifications, dashboards, toolset ' +
      'management, deposits, the provider console…) refuses every key.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(AGENT_SCOPES, { each: true })
  scopes?: AgentScope[];

  @ApiPropertyOptional({
    description:
      `ISO-8601. Omitted: ${CREDENTIAL_DEFAULT_LIFETIME_DAYS} days from now. Must be in the ` +
      `future and at most ${CREDENTIAL_MAX_LIFETIME_DAYS} days away; a key always expires`,
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date;
}

/**
 * The one and only time the secret is visible. `token` is never
 * stored; only its SHA-256 (`AgentCredentialEntity.tokenHash`) is. Any
 * endpoint that could re-display this value is a bug.
 */
export class CreateAgentCredentialResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  agentId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: 'Clear-text leading characters, for disambiguation only' })
  prefix: string;

  @ApiProperty({
    description:
      'The full secret. Shown exactly once — copy it now. We cannot show it again; create a new one if you lose it.',
    example: 'assay_sk_live_a91f4c2e7b3d0918f6c5a2e4b8d17f30',
  })
  token: string;

  @ApiProperty({ enum: AgentScope, isArray: true })
  scopes: string[];

  @ApiProperty()
  expiresAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}
