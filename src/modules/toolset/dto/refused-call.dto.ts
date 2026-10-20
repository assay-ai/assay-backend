import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

import { ListQueryDto } from '@shared/api';

import { EndpointKind } from '../domain/mcp-url';
import { RefusalLayer } from '../domain/attribution';

export class ListRefusedCallsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ description: 'Only this agent’s refused calls' })
  @IsOptional()
  @IsUUID()
  agentId?: string;
}

export class RefusedCallParamsDto {
  @ApiProperty({ description: 'The refused call’s id, as in `fixUrl` (`/spend/calls?call={id}`)' })
  @IsUUID()
  callId: string;
}

export class RefusedProviderDto {
  @ApiProperty()
  providerId: string;

  @ApiProperty({
    nullable: true,
    description: 'The provider’s display name, also after it was delisted; `null` if unknown',
  })
  providerName: string | null;

  @ApiProperty({
    description:
      'NOT_IN_ALLOWED_PROVIDERS | EXCLUDED_BY_TOOLSET | EXCLUDED_BY_AGENT | BELOW_MIN_TIER | ' +
      'ABOVE_MAX_PRICE | BELOW_MIN_QUALITY | PAYEE_NO_LONGER_ELIGIBLE | MISSING_OUTPUT_FIELD | ' +
      'UNSUPPORTED_INPUT_FIELD | CONTRACT_VERSION_MISMATCH (T3; never a provider-quality event)',
  })
  reason: string;

  @ApiProperty({
    enum: ['AGENT', 'TOOLSET', 'REQUEST', 'MIGRATION'],
    description:
      'Whose rule dropped it: the agent’s limits, the tool set entry, the call’s own ' +
      'arguments (an optional input) or a contract version the binding does not serve',
  })
  source: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'On MISSING_OUTPUT_FIELD and UNSUPPORTED_INPUT_FIELD: the fields',
  })
  fields?: string[];

  @ApiPropertyOptional({
    type: [Number],
    description: 'On CONTRACT_VERSION_MISMATCH: the contract majors the binding serves, e.g. `[1]`',
  })
  servedMajors?: number[];

  @ApiPropertyOptional({
    description: 'On CONTRACT_VERSION_MISMATCH: the contract major the call was routed at',
  })
  requestedMajor?: number;

  @ApiPropertyOptional({
    type: [Number],
    nullable: true,
    description:
      'On CONTRACT_VERSION_MISMATCH: the majors the call may use (toolset entry range and ' +
      '`?tools=name@N` pin); `null` when unconstrained',
  })
  requestedRange?: number[] | null;

  @ApiProperty({ description: 'Human-readable; the structured fields above are what to render' })
  detail: string;

  @ApiPropertyOptional({ description: 'On PAYEE_NO_LONGER_ELIGIBLE: the rule it now fails' })
  rule?: string;
}

/** What to call instead of a retired contract version. */
export class RefusedCallReplacementDto {
  @ApiProperty({ description: 'The tool to call: another tool, or the same tool at another major' })
  toolId: string;

  @ApiProperty({ description: 'Its name' })
  name: string;

  @ApiProperty({ nullable: true, description: 'The major to call it at; `null` if unknown' })
  major: number | null;

  @ApiProperty({ nullable: true, description: 'Its served version, e.g. `2.0.0`' })
  semver: string | null;

  @ApiProperty({ description: 'As the agent was told, e.g. `get_weather@2 (v2.0.0)`' })
  label: string;
}

/** The refusal's structured details, per code. */
export class RefusedCallDetailsDto {
  @ApiPropertyOptional({
    type: RefusedCallReplacementDto,
    nullable: true,
    description: 'On CONTRACT_VERSION_RETIRED: what replaces it; `null` when nothing does',
  })
  replacement?: RefusedCallReplacementDto | null;
}

/** One call refused before anything was charged (design spec §7.10, "refused calls"). */
export class RefusedCallDto {
  @ApiProperty()
  callId: string;

  @ApiProperty()
  agentId: string;

  @ApiProperty({ nullable: true, description: '`null` when the name matched no tool' })
  toolId: string | null;

  @ApiProperty({ nullable: true, description: 'The name the agent called' })
  toolName: string | null;

  @ApiProperty({
    description:
      'TOOL_NOT_IN_TOOLSET | TOOL_NOT_ALLOWED | NO_PROVIDER_MATCHES_RULES | TOOL_REMOVED | ' +
      'CONTRACT_VERSION_RETIRED | UNSUPPORTED_INPUT_FIELD, or ' +
      'a spend-limit, quota or supply refusal (MCP_SPEND_LIMIT_EXCEEDED, MCP_QUOTA_EXCEEDED, …)',
  })
  refusalCode: string;

  @ApiProperty({ enum: RefusalLayer })
  refusalLayer: RefusalLayer;

  @ApiProperty({ description: 'Never charged; always false' })
  charged: false;

  @ApiProperty({
    type: [RefusedProviderDto],
    description: 'On NO_PROVIDER_MATCHES_RULES and UNSUPPORTED_INPUT_FIELD',
  })
  providers: RefusedProviderDto[];

  @ApiProperty({ type: RefusedCallDetailsDto })
  details: RefusedCallDetailsDto;

  @ApiProperty({ enum: EndpointKind, nullable: true })
  endpointKind: EndpointKind | null;

  @ApiProperty({ nullable: true })
  toolsetId: string | null;

  @ApiProperty({ nullable: true, description: '`null` with a toolset: its Draft' })
  toolsetVersion: number | null;

  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'The view filters of the URL, e.g. `{ "tools": ["get_weather"], "free": true }`',
  })
  viewFilter: Record<string, unknown> | null;

  @ApiProperty()
  createdAt: string;
}
