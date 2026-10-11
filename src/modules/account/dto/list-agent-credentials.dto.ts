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

  @ApiPropertyOptional({
    nullable: true,
    description:
      'CAIP-10 of the delegate key this credential proved it holds and signs vouchers with ' +
      '(agent payment delegation), or null. Spending also needs the payer to authorise the key ' +
      'on chain (`/escrow/delegates`).',
  })
  delegateAccount: string | null;

  @ApiPropertyOptional({ nullable: true })
  delegateBoundAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}
