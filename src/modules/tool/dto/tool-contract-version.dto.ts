import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ToolContractVersion, ToolTier, ToolVersionStatus } from '../ports/tool.types';

/** One worked example of a call. */
export class ToolExampleDto {
  @ApiPropertyOptional({ example: 'Weather in Lisbon' })
  title?: string;

  @ApiProperty({ type: 'object', additionalProperties: true, example: { latitude: 38.72 } })
  arguments: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  result?: unknown;
}

/**
 * One published version of a tool's contract (design spec §7.2
 * `tool_versions`, §7.5): what the catalogue, the provider binding editor and
 * the operator editor show per version.
 */
export class ToolContractVersionDto {
  @ApiProperty({
    description: 'Sequence number within the tool (`tools.current_version`).',
    example: 2,
  })
  version: number;

  @ApiProperty({ example: '1.1.0' })
  semver: string;

  @ApiProperty({ example: 1 })
  major: number;

  @ApiProperty({ enum: ToolVersionStatus })
  status: ToolVersionStatus;

  @ApiProperty({ description: 'At most 200 characters: the only text tools/list sends.' })
  summary: string;

  @ApiProperty()
  description: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  inputSchema: unknown;

  @ApiProperty({ type: 'object', additionalProperties: true })
  outputSchema: unknown;

  @ApiProperty({
    type: [String],
    description: 'Inputs a call may use; routed only to bindings that support them.',
  })
  optionalInputFields: string[];

  @ApiProperty({
    type: [String],
    description: 'Outputs a binding may declare; a toolset entry may require them.',
  })
  optionalOutputFields: string[];

  @ApiProperty({ type: [ToolExampleDto] })
  examples: ToolExampleDto[];

  @ApiProperty({ enum: ToolTier })
  tier: ToolTier;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'DEPRECATED and RETIRED only.',
  })
  sunsetAt: Date | null;

  @ApiProperty({ type: String, nullable: true })
  changelog: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  publishedAt: Date | null;

  @ApiProperty({ description: 'Unpinned URLs serve this version.' })
  isCurrent: boolean;

  static of(
    version: ToolContractVersion,
    currentVersion: number | null | undefined,
  ): ToolContractVersionDto {
    return {
      version: version.version,
      semver: version.semver,
      major: version.major,
      status: version.status,
      summary: version.summary,
      description: version.description,
      inputSchema: version.inputSchema,
      outputSchema: version.outputSchema,
      optionalInputFields: [...version.optionalInputFields],
      optionalOutputFields: [...version.optionalOutputFields],
      examples: version.examples.map((example) => ({ ...example })),
      tier: version.tier,
      sunsetAt: version.sunsetAt,
      changelog: version.changelog,
      publishedAt: version.publishedAt,
      isCurrent: currentVersion != null && version.version === currentVersion,
    };
  }
}

/** One published version in a listing: no schemas, just what a card shows. */
export class ToolVersionBriefDto {
  @ApiProperty({ example: 2 })
  version: number;

  @ApiProperty({ example: '1.1.0' })
  semver: string;

  @ApiProperty({ example: 1 })
  major: number;

  @ApiProperty({ enum: ToolVersionStatus })
  status: ToolVersionStatus;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  sunsetAt: Date | null;

  @ApiProperty({ type: String, nullable: true })
  changelog: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  publishedAt: Date | null;

  @ApiProperty()
  isCurrent: boolean;

  static of(
    version: ToolContractVersion,
    currentVersion: number | null | undefined,
  ): ToolVersionBriefDto {
    return {
      version: version.version,
      semver: version.semver,
      major: version.major,
      status: version.status,
      sunsetAt: version.sunsetAt,
      changelog: version.changelog,
      publishedAt: version.publishedAt,
      isCurrent: currentVersion != null && version.version === currentVersion,
    };
  }
}

/**
 * What one listed provider declares for a tool: the majors it serves and the
 * optional fields it returns and accepts. Only providers in the catalogue's
 * provider listing (ACTIVE, not blocked, an ACTIVE binding at its published
 * revision) appear. A provider with several bindings shows their union.
 */
export class ToolVersionProviderDto {
  @ApiProperty()
  providerId: string;

  @ApiProperty({ description: 'As in the catalogue provider listing' })
  legalName: string;

  @ApiProperty({ type: [Number], example: [1, 2], description: 'Contract majors it serves' })
  servedMajors: number[];

  @ApiProperty({
    type: [String],
    example: ['uv_index'],
    description: 'Optional output fields it returns (`provides_output_fields`)',
  })
  providesOutputFields: string[];

  @ApiProperty({
    type: [String],
    example: ['units'],
    description: 'Optional input fields it accepts (`supports_input_fields`)',
  })
  supportsInputFields: string[];
}

/** A tool's published versions with their changelog, newest first. */
export class ToolVersionListDto {
  @ApiProperty()
  toolId: string;

  @ApiProperty({ example: 'get_weather' })
  name: string;

  @ApiProperty({ type: String, nullable: true, example: '1.1.0' })
  currentVersion: string | null;

  @ApiProperty({ type: [ToolContractVersionDto] })
  versions: ToolContractVersionDto[];

  @ApiProperty({
    type: [ToolVersionProviderDto],
    description:
      'Per listed provider serving the tool: the majors and optional fields it declares, ' +
      'sorted by legal name',
  })
  providers: ToolVersionProviderDto[];
}
