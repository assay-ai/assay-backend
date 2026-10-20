import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

import { PricingMode } from '@modules/tool/ports/tool.types';
import { EndpointKind } from '@modules/toolset/domain/mcp-url';

/**
 * The Connect sheet's client tabs, and the client ids `assay-mcp add --client`
 * takes (spec §7.10 item 5, §8.4). `agent_connect_urls.client` is
 * `varchar(24)`: every id fits.
 */
export const CONNECT_CLIENTS = [
  'claude-code',
  'codex',
  'cursor',
  'vscode',
  'windsurf',
  'gemini',
  'claude-desktop',
  'claude-ai',
  'chatgpt',
  'other',
] as const;

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

  @ApiPropertyOptional({
    description:
      'The server name the client uses: a lowercase letter, then lowercase letters, digits or dashes, at most 56 characters. The per-URL length rule is checked by the Connect UI',
  })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9-]{0,55}$/)
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
    description: 'The `assay/price` display, e.g. "up to $0.01"; `null` when unpriced',
  })
  price: string | null;

  @ApiProperty({ description: 'Providers left under the URL’s and the agent’s rules' })
  providerCount: number;

  @ApiProperty({ description: 'The rules leave no provider: "No provider fits your limits"' })
  noProviderFits: boolean;

  @ApiProperty({
    enum: ['RULES', 'OTHER_CHAIN'],
    nullable: true,
    description:
      'Why this agent cannot run it here: the rules removed every provider (`RULES`), or it has a ' +
      'paid price but no provider settles on the agent’s own chain (`OTHER_CHAIN`; a FREEMIUM tool ' +
      'still serves its free calls). Display only. `null` when it can run.',
  })
  noFitReason: NoFitReason | null;
}

/** Why a tool has no provider for this agent here; see `PreviewToolDto.noFitReason`. */
export type NoFitReason = 'RULES' | 'OTHER_CHAIN';

/** A tool a warning is about: its id and the name an agent sees. */
export class PreviewWarningToolDto {
  @ApiProperty({
    nullable: true,
    description: '`null` for an ignored `?tools=` name matching no tool',
  })
  toolId: string | null;

  @ApiProperty()
  name: string;
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

  @ApiProperty({ type: [PreviewWarningToolDto], description: 'The tools it is about' })
  tools: PreviewWarningToolDto[];
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

  @ApiProperty({
    enum: ['FULL', 'SEARCH'],
    description: 'How `tools/list` presents this URL for this agent, AUTO already decided',
  })
  discovery: 'FULL' | 'SEARCH';

  @ApiProperty({
    description: 'What `tools/list` returns here for this agent (SEARCH: pinned + 3 meta tools)',
  })
  listedCount: number;

  @ApiProperty({ description: 'Tools this agent can reach here: listed, or through search' })
  reachableCount: number;

  @ApiProperty({ type: [String], description: 'The names `tools/list` returns, in order' })
  listedTools: string[];

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

  @ApiProperty({
    nullable: true,
    description:
      'For a server that shows every tool: the same URL in search mode, for "Switch to ' +
      'search" when servers are over budget. `null` when it already searches.',
  })
  searchUrl: string | null;

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

  @ApiProperty({
    description:
      'The URL is pinned to `@n` and a newer version is served on its own path: `/@…` only ' +
      'versions published PUBLIC, a link what that link serves, `/my/` the newest',
  })
  updateAvailable: boolean;

  @ApiProperty({ nullable: true, description: 'Set only when `updateAvailable`' })
  latestVersion: number | null;

  @ApiProperty({
    nullable: true,
    description: 'This URL at `latestVersion`, for "Copy v4 URL"; set only when `updateAvailable`',
  })
  latestUrl: string | null;
}

export class ServersInUseDto {
  @ApiProperty({ type: [ServerInUseDto] })
  servers: ServerInUseDto[];

  @ApiProperty({
    description: 'The servers that show every tool list more than 25 tools between them',
  })
  overBudget: boolean;
}
