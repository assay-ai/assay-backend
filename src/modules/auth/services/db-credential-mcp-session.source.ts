import { Injectable } from '@nestjs/common';

import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { isAgentCredentialToken } from '@modules/account/constants/agent-credential-token.constants';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpSession, McpSessionPort } from '@modules/mcp/ports/mcp-session.port';
import { digestToken } from '@shared/crypto/token-digest';

import { CacheableSession, CacheableSessionSource } from '../session-cache/caching-session.source';
import { CredentialSessionResolver } from './credential-session.resolver';

/**
 * `agent_credentials` bearer tokens (`assay_sk_live_…`), resolved to a
 * session — the third session source.
 *
 * `POST /agents/:agentId/credentials` mints these and stores only their
 * SHA-256 (`agent_credentials.token_hash`) — but originally nothing read that
 * column. A credential a user creates in the UI has been
 * rejected by the MCP endpoint since the day it was mintable. This class is what
 * closes that: the same digest the writer computes (`digestToken`, shared
 * so the two paths cannot drift), looked up through
 * `AgentCredentialRepository.findByTokenHash` — the deliberate cross-tenant
 * read that discovers *which* tenant a token belongs to, because a session
 * source authenticating a bearer token has no tenant to supply up front.
 *
 * ## The prefix check is load-bearing, not an optimisation
 *
 * `CompositeMcpSessionSource` only advances to the next source when this one
 * raises `MCP_CREDENTIAL_INVALID` — every other error stops the chain. A
 * Privy access token is JWT-shaped (`eyJ…`), never `assay_sk_live_…`-shaped,
 * so refusing anything without the prefix *before* touching the database is
 * what lets a Privy caller reach `PrivyMcpSessionSource` at all in `both`
 * mode. Skip this check (or get it wrong) and this source would swallow
 * every bearer token, Privy's included, into one `MCP_CREDENTIAL_INVALID` and
 * the next source in the chain would never run.
 *
 * ## Everything after the row lookup is `CredentialSessionResolver`'s
 *
 * Inactive rows, the agent join, the organization/agent/wallet refusals, the
 * `last_used_at` stamp and the session shape live there, shared with the
 * OAuth source so an API key and an OAuth grant for the same agent resolve
 * identically. An API key always has `paymentsAllowed: true` (spec §6.3.13).
 *
 * ## Timing-safety: considered, and deliberately not added here
 *
 * `ConfigMcpSessionSource.find` walks every configured digest through
 * `timingSafeEqual` because *that* comparison happens in application code,
 * over an in-memory list, where the number of bytes that matched before a
 * mismatch could otherwise leak through wall-clock time. Nothing here does a
 * byte-by-byte comparison at all: `findByTokenHash` hands the digest to
 * Postgres as a bound parameter and lets a B-tree equality lookup on
 * `uq_agent_credentials_token` answer it. A SHA-256 digest is uniformly
 * random, so the index has no meaningful prefix structure to time against,
 * and the lookup's latency is dominated by a network round trip no
 * application-level constant-time wrapper touches. Adding a `timingSafeEqual`
 * pass here would mean fetching every credential to compare in-process —
 * defeating the point of the unique index — to guard a comparison the
 * database, not this class, performs. So this is the same shape as looking
 * up a password-reset token by its hash: correct, and not cargo-culted from
 * `ConfigMcpSessionSource`.
 */
@Injectable()
export class DbCredentialMcpSessionSource implements McpSessionPort, CacheableSessionSource {
  constructor(
    private readonly credentials: AgentCredentialRepository,
    private readonly resolver: CredentialSessionResolver,
  ) {}

  async resolve(bearerToken: string | null): Promise<McpSession> {
    return (await this.resolveForCache(bearerToken)).session;
  }

  /** The session, valid until the key's own `expires_at` at the latest. */
  async resolveForCache(bearerToken: string | null): Promise<CacheableSession> {
    if (!bearerToken || !isAgentCredentialToken(bearerToken)) {
      throw McpErrors.credentialInvalid();
    }

    const credential = await this.credentials.findByTokenHash(digestToken(bearerToken));
    if (!credential) {
      throw McpErrors.credentialInvalid();
    }

    const session = await this.resolver.sessionFor(credential, { paymentsAllowed: true });
    return { session, notAfter: credential.expiresAt ?? null };
  }
}
