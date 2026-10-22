import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ListQueryDto } from '@shared/api';

/** The client an OAuth grant was issued to (spec §7.10 item 4). */
export class AgentCredentialOAuthClientDto {
  @ApiProperty({ description: 'The public `client_id`: a CIMD URL, `dcr_…`, or the built-in URL' })
  clientId: string;

  @ApiProperty({
    description:
      "The client's own name, or its listed display name when verified. Self-declared otherwise.",
  })
  name: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: "eTLD+1 of a CIMD client's host; null when no domain is proven (DCR, built-in)",
  })
  registrableDomain: string | null;

  @ApiProperty({
    description:
      'Listed in OAUTH_VERIFIED_CLIENTS and every registered redirect is a vendor HTTPS callback. ' +
      'Never true for the built-in client.',
  })
  verified: boolean;

  @ApiProperty({
    description:
      'The client may bind a payment key (OAUTH_PAYMENT_CLIENTS: the built-in client only)',
  })
  paymentClient: boolean;
}

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

  @ApiProperty({
    enum: ['API_KEY', 'OAUTH'],
    description: 'How the credential was obtained. Everything else about it is the same.',
  })
  issuedVia: 'API_KEY' | 'OAUTH';

  @ApiProperty({
    nullable: true,
    type: AgentCredentialOAuthClientDto,
    description: 'The client an OAuth grant was issued to; null for an API key',
  })
  oauthClient: AgentCredentialOAuthClientDto | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Clear-text leading characters, for disambiguation only; null for an OAuth grant',
  })
  prefix: string | null;

  @ApiProperty({
    type: [String],
    description: 'What the key may do: `tools:call`, `payments`, `activity:read`, `reports:write`',
  })
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

  @ApiPropertyOptional({
    nullable: true,
    description:
      'CAIP-10 of a key the agent proved while `delegateAccount` was bound. It waits for the ' +
      "payer's approval on enable-paid (`POST /escrow/delegates` for this key), which makes it " +
      '`delegateAccount` in one step; until then the bound key keeps signing.',
  })
  pendingDelegateAccount: string | null;

  @ApiPropertyOptional({ nullable: true })
  pendingDelegateRequestedAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}

/**
 * One agent's credentials as `GET /agents?include=credentials` nests them:
 * the items of `GET /agents/:agentId/credentials?limit=50`, and whether that
 * route would have a next page.
 */
export class AgentCredentialsPage {
  @ApiProperty({ type: [AgentCredentialDto] })
  items: AgentCredentialDto[];

  @ApiProperty({
    description: 'More credentials exist: read them with `GET /agents/:agentId/credentials`',
  })
  hasMore: boolean;
}
