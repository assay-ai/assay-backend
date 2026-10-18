import { Inject, Injectable, Optional } from '@nestjs/common';
import { IsNull } from 'typeorm';

import { CredentialIssuedVia } from '@database/postgres/entities/agent-credential.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { OAuthAccessTokenRepository } from '@database/postgres/repositories/oauth-access-token.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpSession, McpSessionPort } from '@modules/mcp/ports/mcp-session.port';
import { OAUTH_SESSION_CONFIG, OAuthSessionConfig } from '@modules/oauth/config/oauth.config';
import { hashOpaqueToken, isWellFormed } from '@modules/oauth/domain/opaque-token';
import { isPaymentClient } from '@modules/oauth/domain/payment-client';
import { APP_ROLE, AppRole, resolveAppRole } from '@shared/app-role/app-role';

import { AuthErrors } from '../errors/auth.errors';
import { CredentialSessionResolver } from './credential-session.resolver';

/**
 * OAuth access tokens (`assay_at_…`), resolved to a session (spec §6.4).
 *
 * An OAuth grant is one `agent_credentials` row, like an API key; the access
 * token only names it. So once the row is found, the session comes from
 * {@link CredentialSessionResolver}, the same code an API key goes through:
 * same organization, agent and wallet checks, same narrowing (by credential
 * id), same delegate, and `BlocklistSessionSource` wraps both alike
 * (R-OA-18). The one input this source decides is `paymentsAllowed`.
 *
 * ## Order
 *
 * 1. Not a well-formed `assay_at_` token → `MCP_CREDENTIAL_INVALID` with no
 *    read (R-OA-20). Load-bearing for the same reason as in
 *    `DbCredentialMcpSessionSource`: the composite only moves on after
 *    `MCP_CREDENTIAL_INVALID`, so a Privy JWT must leave here untouched.
 * 2. The token row by its digest, on the primary database, every request
 *    (R-OA-19): missing, expired, revoked, or an audience other than
 *    `MCP_PUBLIC_URL` → `MCP_CREDENTIAL_INVALID` (T15).
 * 3. The credential, scoped to the token's organization and `issued_via
 *    'OAUTH'`, and its client. A missing, revoked or expired credential is
 *    refused here as invalid, before the host check, so a dead grant never
 *    learns which host it may use.
 * 4. On the API app, a client outside `OAUTH_PAYMENT_CLIENTS` → 403
 *    `AUTH_CLIENT_NOT_ALLOWED_HERE` (R-OA-21). Not `MCP_CREDENTIAL_INVALID`:
 *    the token is genuine, so the composite must stop rather than try Privy.
 * 5. `first_used_at`, best-effort, once (`WHERE first_used_at IS NULL`).
 * 6. `sessionFor(credential, { paymentsAllowed: client ∈ OAUTH_PAYMENT_CLIENTS })`,
 *    which re-checks the credential and checks the agent and organization on
 *    every request (T16).
 *
 * The lookup is by digest only; the token itself is never passed to the
 * database, logged, or kept. See `DbCredentialMcpSessionSource` for why an
 * indexed digest lookup needs no constant-time comparison.
 *
 * `APP_ROLE` is optional: a container without `AppRoleModule` is treated as
 * the API, the strict side.
 */
@Injectable()
export class OAuthAccessTokenMcpSessionSource implements McpSessionPort {
  private readonly role: AppRole;

  constructor(
    private readonly tokens: OAuthAccessTokenRepository,
    private readonly credentials: AgentCredentialRepository,
    private readonly clients: OAuthClientRepository,
    private readonly resolver: CredentialSessionResolver,
    @Inject(OAUTH_SESSION_CONFIG) private readonly config: OAuthSessionConfig,
    @Optional() @Inject(APP_ROLE) role?: AppRole,
  ) {
    this.role = resolveAppRole(role);
  }

  async resolve(bearerToken: string | null): Promise<McpSession> {
    if (!isWellFormed(bearerToken, 'assay_at_')) {
      throw McpErrors.credentialInvalid();
    }

    const token = await this.tokens.findByTokenHash(hashOpaqueToken(bearerToken));
    if (
      !token ||
      token.revokedAt ||
      token.expiresAt.getTime() <= Date.now() ||
      token.audience !== this.config.audience
    ) {
      throw McpErrors.credentialInvalid();
    }

    const credential = await this.credentials.findOneBy({
      organizationId: token.organizationId,
      id: token.credentialId,
      issuedVia: CredentialIssuedVia.OAUTH,
    });
    if (
      !credential ||
      !credential.oauthClientId ||
      credential.revokedAt ||
      (credential.expiresAt && credential.expiresAt.getTime() <= Date.now())
    ) {
      throw McpErrors.credentialInvalid();
    }

    const client = await this.clients.findOneBy({ id: credential.oauthClientId });
    if (!client) {
      throw McpErrors.credentialInvalid();
    }

    const paymentsAllowed = isPaymentClient(this.config.paymentClients, client.clientId);
    if (this.role === 'api' && !paymentsAllowed) {
      throw AuthErrors.clientNotAllowedHere();
    }

    if (!token.firstUsedAt) {
      // Fire-and-forget and scoped, like `last_used_at` in the resolver. The
      // `IS NULL` guard keeps the first use when two requests race. Its own
      // autocommit statement, never in a transaction with the credential's
      // `last_used_at` stamp: revocation locks the credential, then its tokens,
      // so holding a token row while waiting on the credential could deadlock.
      void this.tokens
        .update(
          { organizationId: token.organizationId, id: token.id, firstUsedAt: IsNull() },
          { firstUsedAt: new Date() },
        )
        .catch(() => {
          // Best-effort: a failed stamp must never refuse a valid token.
        });
    }

    return this.resolver.sessionFor(credential, { paymentsAllowed });
  }
}
