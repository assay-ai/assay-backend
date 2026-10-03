import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ListQueryDto } from '@shared/api';

/** `GET /api/v1/agents/:agentId/credentials`. No extra filters. */
export class ListAgentCredentialsQueryDto extends ListQueryDto {}

/**
 * A credential, never carrying `tokenHash` — see `AgentCredentialEntity`'s
 * class comment on why the secret is not recoverable after creation.
 */
export class AgentCredentialDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  agentId: string;

  @ApiProperty({ description: 'Human label — "CI deploy", "local dev"' })
  name: string;

  @ApiProperty({ description: 'Clear-text leading characters, for disambiguation only' })
  prefix: string;

  @ApiProperty({ type: [String] })
  scopes: string[];

  @ApiPropertyOptional({ nullable: true })
  lastUsedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  expiresAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  revokedAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The credential this one replaced, if rotated',
  })
  rotatedFromId: string | null;

  @ApiProperty()
  createdAt: Date;
}
