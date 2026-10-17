import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

import { PricingMode } from '@modules/tool/ports/tool.types';
import { EndpointKind } from '@modules/toolset/domain/mcp-url';

export const CONNECT_CLIENTS = ['claude-code', 'claude-desktop', 'cursor', 'other'] as const;

export class PreviewMcpUrlBodyDto {
  @ApiProperty({
    description: 'An MCP URL of this host. Parsed only, never fetched',
    example: 'https://mcp.assay.ai/my/research?tools=get_weather',
  })
  @IsString()
  @MaxLength(2048)
  url: string;

  @ApiProperty({ description: 'The agent whose access the preview is computed under' })
  @IsUUID()
  agentId: string;
}

export class RecordConnectUrlBodyDto {
  @ApiProperty({ description: 'The MCP URL the Connect sheet handed out' })
  @IsString()
  @MaxLength(2048)
  url: string;

  @ApiPropertyOptional({ description: 'The suggested server name, at most 9 characters' })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9_-]{0,8}$/)
  serverName?: string;

  @ApiPropertyOptional({
    enum: CONNECT_CLIENTS,
    description: 'The client tab, remembered per agent',
  })
  @IsOptional()
  @IsIn(CONNECT_CLIENTS)
  client?: (typeof CONNECT_CLIENTS)[number];
}

export class PreviewToolDto {
  @ApiProperty()
  toolId: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  category: string;

  @ApiProperty({ description: 'Listed by `tools/list` on this URL for this agent' })
  listed: boolean;

  @ApiProperty({ description: 'False when the agent’s access refuses it here' })
  allowed: boolean;

  @ApiProperty({ enum: PricingMode, nullable: true })
  pricingMode: PricingMode | null;

  @ApiProperty({
    nullable: true,
    description: 'The `x402/price` display, e.g. "up to $0.01"; `null` when unpriced',
  })
  price: string | null;

  @ApiProperty({ description: 'Providers left under the URL’s and the agent’s rules' })
  providerCount: number;

  @ApiProperty({ description: 'The rules leave no provider: "No provider fits your limits"' })
  noProviderFits: boolean;
}

export class PreviewWarningDto {
  @ApiProperty({
    enum: [
      'NO_BACKUP_PROVIDER',
      'BLOCKED_BY_ACCESS',
      'NOTHING_ALLOWED',
      'NO_PROVIDER_FITS',
      'IGNORED_TOOLS',
    ],
  })
  code: string;

  @ApiProperty({ type: [String], description: 'The tool names it is about' })
  tools: string[];
}

export class McpUrlPreviewDto {
  @ApiProperty({ description: 'The canonical form: the key the web app and the server agree on' })
  canonicalUrl: string;

  @ApiProperty({ enum: EndpointKind })
  endpointKind: EndpointKind;

  @ApiProperty({ nullable: true })
  toolsetId: string | null;

  @ApiProperty({ nullable: true })
  toolsetName: string | null;

  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'The view filters that differ from the default',
  })
  viewFilter: Record<string, unknown> | null;

  @ApiProperty({ enum: ['FULL', 'SEARCH'], description: 'FULL until search mode ships (T2)' })
  discovery: 'FULL' | 'SEARCH';

  @ApiProperty({ description: 'What `tools/list` returns here for this agent' })
  listedCount: number;

  @ApiProperty({ description: 'Approximate tokens the listed definitions cost a model' })
  estimatedTokens: number;

  @ApiProperty({ description: '`?free=1`: every call through this URL is free or refused' })
  freeOnly: boolean;

  @ApiProperty({ type: [PreviewToolDto], description: 'Every tool the URL serves, allowed or not' })
  tools: PreviewToolDto[];

  @ApiProperty({ type: [String], description: '`?tools=` names this URL does not serve' })
  ignoredTools: string[];

  @ApiProperty({ type: [PreviewWarningDto] })
  warnings: PreviewWarningDto[];
}

export class ServerInUseDto {
  @ApiProperty()
  canonicalUrl: string;

  @ApiProperty({ enum: EndpointKind })
  endpointKind: EndpointKind;

  @ApiProperty({ nullable: true })
  toolsetId: string | null;

  @ApiProperty({ description: 'The tool set name, else the suggested server name, else "assay"' })
  name: string;

  @ApiProperty({ nullable: true })
  serverName: string | null;

  @ApiProperty({ nullable: true, enum: CONNECT_CLIENTS })
  client: string | null;

  @ApiProperty({
    nullable: true,
    description: '`null` when the URL no longer serves (deleted set)',
  })
  toolCount: number | null;

  @ApiProperty({ nullable: true })
  estimatedTokens: number | null;

  @ApiProperty({ enum: ['FULL', 'SEARCH'] })
  discovery: 'FULL' | 'SEARCH';

  @ApiProperty({ nullable: true })
  lastCallAt: string | null;

  @ApiProperty({ nullable: true, description: 'When the Connect sheet handed it out' })
  handedOutAt: string | null;

  @ApiProperty({ nullable: true })
  firstCallAt: string | null;

  @ApiProperty({ description: 'Handed out, and no call has arrived through it yet' })
  waitingForFirstCall: boolean;

  @ApiProperty({ description: 'Whether the URL still serves anything' })
  available: boolean;

  @ApiProperty({ description: 'A newer tool set version exists (versions arrive in T2)' })
  updateAvailable: boolean;
}

export class ServersInUseDto {
  @ApiProperty({ type: [ServerInUseDto] })
  servers: ServerInUseDto[];

  @ApiProperty({
    description: 'The servers that show every tool list more than 25 tools between them',
  })
  overBudget: boolean;
}
