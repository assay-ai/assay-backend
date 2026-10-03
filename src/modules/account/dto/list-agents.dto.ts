import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ListQueryDto } from '@shared/api';

/**
 * `GET /api/v1/agents`. No resource-specific filters: the `agents`
 * table is scoped and small per organization, so a filter here would be
 * filtering a set the client could as easily filter itself.
 *
 * `from` / `to` (inherited from `ListQueryDto`) filter on `agents.created_at`
 * — see `AgentRepository.list`.
 */
export class ListAgentsQueryDto extends ListQueryDto {}

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
