import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/**
 * Shared across the credentials endpoints nested under `/agents/:agentId`.
 *
 * `agent_credentials.agent_id` is a `uuid` column (like `payment_intents
 * .agent_id`), so this validates as one even though there is no `agents`
 * table to check membership against — see `AgentsService`'s class comment.
 */
export class AgentIdParamDto {
  @ApiProperty({ description: 'The agent id' })
  @IsUUID()
  agentId: string;
}
