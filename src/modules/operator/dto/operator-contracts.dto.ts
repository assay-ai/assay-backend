import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import { ContractChangeKind, VersionBump } from '@modules/tool/domain/contract';
import {
  ToolContractVersionDto,
  ToolExampleDto,
} from '@modules/tool/dto/tool-contract-version.dto';
import { ToolStatus, ToolTier } from '@modules/tool/ports/tool.types';

import { ReasonCode, Trimmed, TrimmedOrAbsent } from './operator-console.dto';

/**
 * The operator contract editor (design spec §7.5 "Editor", §7.9 Operator):
 * draft a standard contract and its versions, see the schema diff and the
 * bump it implies, publish (two-person), move the current version
 * (two-person) and deprecate a major.
 */

export class CreateStandardToolBodyDto {
  @ApiProperty({
    example: 'get_weather',
    description: 'snake_case, at most 48 characters, no "__"',
  })
  @Matches(/^[a-z][a-z0-9_]{1,47}$/)
  name: string;

  @ApiProperty({ example: 'weather' })
  @Matches(/^[a-z][a-z0-9-]{1,63}$/)
  category: string;

  @ApiPropertyOptional({ type: [String], example: ['temperature'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(/^[a-z0-9][a-z0-9-]{0,31}$/, { each: true })
  tags?: string[];
}

/** The editable DRAFT version. Saving replaces it; nothing serves it until published. */
export class SaveContractDraftBodyDto {
  @ApiProperty({ maxLength: 200, description: 'The only text tools/list sends. One line.' })
  @IsString()
  @Length(1, 200)
  summary: string;

  @ApiProperty({ description: 'Full documentation: get_tool and the catalogue.' })
  @IsString()
  @Length(1, 8000)
  description: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  inputSchema: Record<string, unknown>;

  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  outputSchema: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String], description: 'Input fields a binding opts in to.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  optionalInputFields?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Output fields a binding opts in to.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  optionalOutputFields?: string[];

  @ApiPropertyOptional({ type: [ToolExampleDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  examples?: Record<string, unknown>[];

  @ApiPropertyOptional({ example: 'policy-default' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  verificationPolicyId?: string;

  @ApiPropertyOptional({ enum: ToolTier })
  @IsOptional()
  @IsIn(Object.values(ToolTier))
  tier?: ToolTier;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  changelog?: string;

  @ApiPropertyOptional({
    example: 2,
    description:
      'The published version (`version`) this draft changes; the diff and the bump are ' +
      'computed against it. Defaults to the newest published version.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  baseVersion?: number;
}

/** What every action that reaches traffic carries into the override register. */
export class ContractActionBodyDto {
  @ApiProperty()
  @ReasonCode()
  reasonCode: string;

  @ApiProperty({ minLength: 20 })
  @Trimmed()
  @IsString()
  @Length(20, 1000)
  note: string;

  @ApiPropertyOptional()
  @TrimmedOrAbsent()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}

export class MoveCurrentVersionBodyDto extends ContractActionBodyDto {
  @ApiProperty({ example: 3, description: 'An ACTIVE version (`tool_versions.version`).' })
  @IsInt()
  @Min(1)
  version: number;
}

export class DeprecateVersionBodyDto extends ContractActionBodyDto {
  @ApiProperty({
    example: '2027-02-01T00:00:00Z',
    description: 'UTC; at least 90 days from now. The whole major retires then.',
  })
  @IsISO8601({ strict: true })
  sunsetAt: string;

  @ApiPropertyOptional({ description: 'Another tool that replaces this one, named in notices' })
  @IsOptional()
  @IsUUID()
  replacementToolId?: string;
}

export class ToolIdParamDto {
  @ApiProperty()
  @IsUUID()
  id: string;
}

export class ToolVersionParamDto extends ToolIdParamDto {
  @ApiProperty({ example: 3 })
  @Matches(/^[1-9]\d{0,8}$/)
  version: string;
}

export class ContractChangeDto {
  @ApiProperty({ enum: ContractChangeKind })
  kind: ContractChangeKind;

  @ApiProperty({ enum: ['input', 'output'], nullable: true })
  side: 'input' | 'output' | null;

  @ApiProperty({ type: String, nullable: true })
  field: string | null;

  @ApiProperty({ enum: VersionBump })
  bump: VersionBump;

  @ApiProperty()
  detail: string;
}

/** The DRAFT, its diff against its base and the version it would publish as. */
export class ContractDraftDto {
  @ApiProperty({ description: 'The sequence number it will keep when published' })
  version: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1.1.0',
    description: 'null on a first version',
  })
  baseSemver: string | null;

  @ApiProperty({ type: Number, nullable: true })
  baseVersion: number | null;

  @ApiProperty({ example: '1.2.0', description: 'What publishing it now would make it' })
  nextSemver: string;

  @ApiProperty({ enum: VersionBump, nullable: true, description: 'null: identical to its base' })
  bump: VersionBump | null;

  @ApiProperty({ type: [ContractChangeDto] })
  changes: ContractChangeDto[];

  @ApiProperty({ type: [String], description: 'Empty when it can be published' })
  problems: string[];

  @ApiProperty()
  summary: string;

  @ApiProperty()
  description: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  inputSchema: unknown;

  @ApiProperty({ type: 'object', additionalProperties: true })
  outputSchema: unknown;

  @ApiProperty({ type: [String] })
  optionalInputFields: string[];

  @ApiProperty({ type: [String] })
  optionalOutputFields: string[];

  @ApiProperty({ type: [ToolExampleDto] })
  examples: ToolExampleDto[];

  @ApiProperty({ type: String, nullable: true })
  verificationPolicyId: string | null;

  @ApiProperty({ enum: ToolTier, nullable: true })
  tier: ToolTier | null;

  @ApiProperty({ type: String, nullable: true })
  changelog: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'The operator id who last saved the draft (its creator when never edited); `null` for ' +
      'a seeded version. That operator cannot approve its publish (two-person rule).',
  })
  editedBy: string | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}

/** Per major: its newest version and how many bindings can serve it now. */
export class ContractMajorDto {
  @ApiProperty({ example: 2 })
  major: number;

  @ApiProperty({ example: '2.0.0' })
  latestSemver: string;

  @ApiProperty({ description: 'ACTIVE, DEPRECATED or RETIRED — the newest version’s' })
  status: string;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  sunsetAt: Date | null;

  @ApiProperty({
    description: 'Bindings routing would accept for this major now, under no buyer rules',
  })
  eligibleBindings: number;

  @ApiProperty({ description: 'ACTIVE bindings whose published range covers this major' })
  activeBindings: number;
}

export class OperatorToolSummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ enum: ['STANDARD', 'PROVIDER'] })
  kind: string;

  @ApiProperty()
  category: string;

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({ enum: ToolStatus })
  status: string;

  @ApiProperty({ type: String, nullable: true, example: '1.1.0' })
  currentSemver: string | null;

  @ApiProperty({ type: Number, nullable: true })
  currentVersion: number | null;

  @ApiProperty({ description: 'A DRAFT version exists' })
  hasDraft: boolean;
}

export class OperatorToolListDto {
  @ApiProperty({ type: [OperatorToolSummaryDto], description: 'Every tool, drafts included' })
  tools: OperatorToolSummaryDto[];
}

export class OperatorToolDto extends OperatorToolSummaryDto {
  @ApiProperty({ type: String, nullable: true })
  replacementToolId: string | null;

  @ApiProperty({ type: [ToolContractVersionDto], description: 'Published versions, newest first' })
  versions: ToolContractVersionDto[];

  @ApiProperty({ type: ContractDraftDto, nullable: true })
  draft: ContractDraftDto | null;

  @ApiProperty({ type: [ContractMajorDto] })
  majors: ContractMajorDto[];

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'The version the editor suggests moving current_version to: a newer major with at ' +
      "least 2 eligible bindings, or half of the current major's (§7.3)",
  })
  suggestedCurrentVersion: number | null;

  @ApiProperty({
    format: 'date-time',
    description:
      'The earliest `sunsetAt` a deprecation accepts if sent now: now + the 90-day minimum (UTC)',
  })
  earliestSunsetAt: Date;
}
