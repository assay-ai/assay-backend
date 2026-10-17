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
  @ApiProperty({ description: 'The refused call’s id, as in `fixUrl` (`/calls?call={id}`)' })
  @IsUUID()
  callId: string;
}

export class RefusedProviderDto {
  @ApiProperty()
  providerId: string;

  @ApiProperty({
    description:
      'NOT_IN_ALLOWED_PROVIDERS | EXCLUDED_BY_TOOLSET | EXCLUDED_BY_AGENT | BELOW_MIN_TIER | ' +
      'ABOVE_MAX_PRICE | BELOW_MIN_QUALITY | PAYEE_NO_LONGER_ELIGIBLE',
  })
  reason: string;

  @ApiProperty({ enum: ['AGENT', 'TOOLSET'], description: 'Whose rule dropped it' })
  source: string;

  @ApiProperty()
  detail: string;

  @ApiPropertyOptional({ description: 'On PAYEE_NO_LONGER_ELIGIBLE: the rule it now fails' })
  rule?: string;
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
      'TOOL_NOT_IN_TOOLSET | TOOL_NOT_ALLOWED | NO_PROVIDER_MATCHES_RULES | TOOL_REMOVED, or ' +
      'a spend-limit, quota or supply refusal (MCP_SPEND_LIMIT_EXCEEDED, MCP_QUOTA_EXCEEDED, …)',
  })
  refusalCode: string;

  @ApiProperty({ enum: RefusalLayer })
  refusalLayer: RefusalLayer;

  @ApiProperty({ description: 'Never charged; always false' })
  charged: false;

  @ApiProperty({ type: [RefusedProviderDto], description: 'On NO_PROVIDER_MATCHES_RULES' })
  providers: RefusedProviderDto[];

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
