import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { IsAtomicAmount } from '@shared/decorators/is-atomic-amount.decorator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { ProviderTier } from '@modules/provider/ports/provider.types';

import { AccessMode, ToolAccessStanding } from '../domain/access';

export class AllowedToolsetInputDto {
  @ApiProperty()
  @IsUUID()
  toolsetId: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      '"Lock to vN". `null` follows the latest — offered only for your own tool sets (their ' +
      "Draft) and Official ones. Another organization's tool set must be pinned, so a new " +
      'version never widens access until you move the pin.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number | null;

  @ApiPropertyOptional({
    description:
      "Another organization's link-only tool set: the token from its link, proving you can see it. " +
      'Not stored.',
  })
  @IsOptional()
  @Matches(/^[a-z0-9_-]{22,32}$/)
  unlistedToken?: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Allow its tools only through its own URL, so its rules always apply',
  })
  @IsOptional()
  @IsBoolean()
  viaUrlOnly?: boolean;
}

export class AgentRulesInputDto {
  @ApiPropertyOptional({ type: [String], description: 'Providers this agent never routes to' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  excludeProviderIds?: string[];

  @ApiPropertyOptional({
    nullable: true,
    description: "Atomic units of the spend policy's own asset. `null` removes the limit",
    example: '10000',
  })
  @IsOptional()
  @IsAtomicAmount()
  maxPrice?: string | null;

  @ApiPropertyOptional({
    enum: ProviderTier,
    nullable: true,
    description: '"Only verified providers" sets ESTABLISHED; TRUSTED is API only',
  })
  @IsOptional()
  @IsIn(Object.values(ProviderTier))
  minTier?: ProviderTier | null;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 0,
    maximum: 1,
    description: 'Stored; has no effect until provider quality is measured (backlog G1.1)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(1)
  minQuality?: number | null;
}

/** `PATCH /agents/:agentId/access`. Omitted fields keep their value. */
export class UpdateAgentAccessBodyDto {
  @ApiPropertyOptional({ enum: AccessMode })
  @IsOptional()
  @IsIn(Object.values(AccessMode))
  accessMode?: AccessMode;

  @ApiPropertyOptional({ type: [AllowedToolsetInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AllowedToolsetInputDto)
  allowedToolsets?: AllowedToolsetInputDto[];

  @ApiPropertyOptional({ type: [String], description: '`tools.id` values' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1_000)
  @IsUUID('all', { each: true })
  allowedToolIds?: string[];

  @ApiPropertyOptional({ type: AgentRulesInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AgentRulesInputDto)
  rules?: AgentRulesInputDto;

  @ApiPropertyOptional({ type: [String], description: '"Always loaded" tool names, at most 5' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  pinnedTools?: string[];

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  changeReason?: string;
}

/** `PATCH /agent-credentials/:id/access` — narrowing for one key (API only). */
export class UpdateCredentialAccessBodyDto {
  @ApiPropertyOptional({
    enum: AccessMode,
    nullable: true,
    description: '`null` (or ALL) narrows nothing: the key has its agent’s access',
  })
  @IsOptional()
  @IsIn(Object.values(AccessMode))
  accessMode?: AccessMode | null;

  @ApiPropertyOptional({ type: [AllowedToolsetInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AllowedToolsetInputDto)
  allowedToolsets?: AllowedToolsetInputDto[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1_000)
  @IsUUID('all', { each: true })
  allowedToolIds?: string[];
}

export class CredentialIdParamDto {
  @ApiProperty()
  @IsUUID()
  id: string;
}

export class AllowedToolsetDto {
  @ApiProperty()
  toolsetId: string;

  @ApiProperty({ nullable: true })
  version: number | null;

  @ApiProperty()
  viaUrlOnly: boolean;

  @ApiProperty({ nullable: true, description: '`null` when the tool set no longer exists' })
  name: string | null;

  @ApiProperty({ nullable: true })
  slug: string | null;

  @ApiProperty({
    description:
      "Deleted by its owner. Your own: it allows nothing now. Another organization's: the " +
      'pinned version still allows the same tools ("Tool set deleted by its owner").',
  })
  deleted: boolean;

  @ApiProperty({ nullable: true, description: "The owner's public name; `assay` for Official" })
  handle: string | null;

  @ApiProperty({ description: 'Owned by your organization' })
  own: boolean;

  @ApiProperty({
    enum: ['ACTIVE', 'DELETED', 'NOT_SHARED', 'REMOVED'],
    description:
      'NOT_SHARED: its owner stopped sharing it — a `viaUrlOnly` entry stops working when its URL ' +
      'stops serving; REMOVED: taken down, allows nothing',
  })
  status: string;

  @ApiProperty({
    nullable: true,
    description: 'The newest version you could move the pin to — the "Update available" chip',
  })
  latestVersion: number | null;
}

export class AgentRulesDto {
  @ApiProperty({ type: [String] })
  excludeProviderIds: string[];

  @ApiProperty({ type: MoneyDto, nullable: true })
  maxPrice: MoneyDto | null;

  @ApiProperty({ enum: ProviderTier, nullable: true })
  minTier: ProviderTier | null;

  @ApiProperty({ nullable: true })
  minQuality: number | null;
}

/** One tool, as this agent stands with it — "get_weather: 2 of 4 providers left". */
export class AgentToolEffectDto {
  @ApiProperty()
  toolId: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  category: string;

  @ApiProperty({ enum: ToolAccessStanding })
  access: ToolAccessStanding;

  @ApiProperty({ description: 'Providers that can serve it now, before the agent rules' })
  providersTotal: number;

  @ApiProperty({ description: 'Providers left under the agent rules' })
  providersLeft: number;
}

export class AgentAccessDto {
  @ApiProperty()
  agentId: string;

  @ApiProperty({
    enum: ['AGENT', 'ORGANIZATION', 'DEFAULT'],
    description:
      'Where the values come from: this agent’s policy, the organization default, or ' +
      'no policy at all yet',
  })
  scope: 'AGENT' | 'ORGANIZATION' | 'DEFAULT';

  @ApiProperty({ nullable: true })
  policyVersion: number | null;

  @ApiProperty({ enum: AccessMode })
  accessMode: AccessMode;

  @ApiProperty({ type: [AllowedToolsetDto] })
  allowedToolsets: AllowedToolsetDto[];

  @ApiProperty({ type: [String] })
  allowedToolIds: string[];

  @ApiProperty({ type: AgentRulesDto })
  rules: AgentRulesDto;

  @ApiProperty({ type: [String] })
  pinnedTools: string[];

  @ApiProperty({ type: [AgentToolEffectDto], description: 'The combined result, per listed tool' })
  tools: AgentToolEffectDto[];
}

export class OnlyConnectedResultDto extends AgentAccessDto {
  @ApiProperty({
    description:
      'True when one of the servers in use is `/` with no filter: "only what’s connected" ' +
      'then means everything, and access stays ALL',
  })
  everything: boolean;
}

export class CredentialAccessDto {
  @ApiProperty()
  credentialId: string;

  @ApiProperty()
  agentId: string;

  @ApiProperty({ enum: AccessMode, nullable: true })
  accessMode: AccessMode | null;

  @ApiProperty({ type: [AllowedToolsetDto] })
  allowedToolsets: AllowedToolsetDto[];

  @ApiProperty({ type: [String] })
  allowedToolIds: string[];
}
