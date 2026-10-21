import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { ListQueryDto } from '@shared/api';
import { Transform } from 'class-transformer';

import { AgentCredentialsPage } from './list-agent-credentials.dto';

/** What `GET /agents?include=` may add to each row. */
export enum AgentListInclude {
  CREDENTIALS = 'credentials',
  HEALTH = 'health',
}

/**
 * `include` as a list: repeated (`?include=a&include=b`), comma-separated
 * (`?include=a,b`) or both at once, trimmed, with empty entries dropped — so
 * `?include=a,` and `?include=` ask for `a` and for nothing.
 */
export function toIncludeList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/** How many credentials per agent `include` reads: the dashboard's own page size. */
export const AGENT_LIST_CREDENTIALS_LIMIT = 50;

/**
 * `GET /api/v1/agents`. No resource-specific filters: the `agents`
 * table is scoped and small per organization, so a filter here would be
 * filtering a set the client could as easily filter itself.
 *
 * `from` / `to` (inherited from `ListQueryDto`) filter on `agents.created_at`
 * — see `AgentRepository.list`.
 */
export class ListAgentsQueryDto extends ListQueryDto {
  /**
   * Nest each agent's credentials (`credentials`) and/or the key health derived
   * from them (`health`). Either one is a person's read, like
   * `GET /agents/:agentId/credentials`: a machine credential is refused.
   */
  @ApiPropertyOptional({
    enum: AgentListInclude,
    isArray: true,
    description:
      'Comma list or repeated. `credentials`: the first page of each agent’s credentials; ' +
      '`health`: key health derived from it. A person’s session only.',
  })
  @IsOptional()
  @IsEnum(AgentListInclude, { each: true })
  @Transform(({ value }) => toIncludeList(value))
  include?: AgentListInclude[];
}

export class AgentDto {
  @ApiProperty()
  agentId: string;

  @ApiPropertyOptional({ nullable: true, description: 'Human label for logs and the dashboard' })
  label: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'CAIP-10 — the ledger account this agent spends from. `null` until a wallet is linked.',
  })
  agentAccount: string | null;

  @ApiProperty({
    description:
      'CAIP-2 — which chain this agent settles on. Falls back to the deployment’s configured ' +
      'default chain when the agent has no linked wallet yet.',
  })
  chainId: string;

  @ApiProperty({ description: 'How many credentials (live and revoked) this agent has' })
  credentialCount: number;
}

/**
 * An agent's key health, from the same credentials `include=credentials`
 * returns (the first page). Database facts only — see `domain/agent-health.ts`.
 */
export class AgentHealthDto {
  @ApiProperty({ description: 'ISO-8601. The instant "expired" was judged at' })
  evaluatedAt: string;

  @ApiProperty({ description: 'Keys neither revoked nor past `expiresAt`' })
  liveKeyCount: number;

  @ApiProperty({ description: 'Keys not revoked (expiry not considered)' })
  unrevokedKeyCount: number;

  @ApiProperty({ description: 'A live key has a delegate key bound to it' })
  keyBound: boolean;

  @ApiProperty({ description: 'Live keys with a delegate key bound' })
  boundKeyCount: number;

  @ApiProperty({ description: 'A key that is not revoked has been used' })
  firstCallSeen: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'Latest `lastUsedAt` over live keys' })
  lastUsedAt: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Earliest `lastUsedAt` over keys that are not revoked',
  })
  earliestLastUsedAt: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Latest `lastUsedAt` over every key, revoked ones included',
  })
  lastUsedAtAnyKey: string | null;
}

/** A `GET /agents` row with what `include` asked for. */
export class AgentWithIncludesDto extends AgentDto {
  @ApiPropertyOptional({ type: AgentCredentialsPage })
  credentials?: AgentCredentialsPage;

  @ApiPropertyOptional({ type: AgentHealthDto })
  health?: AgentHealthDto;
}
