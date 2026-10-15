import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateAgentCredentialBodyDto {
  @ApiProperty({ description: 'Human label — "CI deploy", "local dev"', example: 'CI deploy' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name: string;

  // Not enforced (review A-4). No scope vocabulary exists yet, every credential
  // minted so far carries `[]`, and nothing reads the column: a credential's
  // powers are those of an agent session whatever it lists here. Enforcing a
  // scope means defining the vocabulary first, so it is described as a label
  // rather than as a permission.
  @ApiPropertyOptional({
    type: [String],
    description:
      'Free-form labels, stored and returned. Not enforced yet: a credential can ' +
      'do everything an agent credential can, whatever it lists here.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  scopes?: string[];

  @ApiPropertyOptional({ description: 'ISO-8601. Omit for a credential that does not expire' })
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

  @ApiProperty({ type: [String] })
  scopes: string[];

  @ApiPropertyOptional({ nullable: true })
  expiresAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}
