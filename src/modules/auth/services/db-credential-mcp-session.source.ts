import { Injectable } from '@nestjs/common';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { AGENT_CREDENTIAL_TOKEN_PREFIX } from '@modules/account/constants/agent-credential-token.constants';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpSession, McpSessionPort } from '@modules/mcp/ports/mcp-session.port';
import { digestToken } from '@shared/crypto/token-digest';

import { AuthErrors } from '../errors/auth.errors';

const SUSPENDED = 'SUSPENDED';

/**
 * `agent_credentials` bearer tokens (`x402_sk_live_…`), resolved to a
 * session — the third session source.
 *
 * `POST /agents/:agentId/credentials` mints these and stores only their
 * SHA-256 (`agent_credentials.token_hash`) — but originally nothing read that
 * column. A credential a user creates in the UI has been
 * rejected by `POST /mcp` since the day it was mintable. This class is what
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
 * Privy access token is JWT-shaped (`eyJ…`), never `x402_sk_live_…`-shaped,
 * so refusing anything without the prefix *before* touching the database is
 * what lets a Privy caller reach `PrivyMcpSessionSource` at all in `both`
 * mode. Skip this check (or get it wrong) and this source would swallow
 * every bearer token, Privy's included, into one `MCP_CREDENTIAL_INVALID` and
 * the next source in the chain would never run.
 *
 * ## `agentAccount` and `chainId` come from `agents`, not from the credential
 *
 * `agent_credentials` has neither column — same reason `PrivyMcpSessionSource`
 * reads them from `agents` rather than the token: they name the account a
 * call is charged to, and the one honest source for that is the row a wallet
 * was actually linked to, not anything a caller-controlled artefact carries.
 * The join is `AgentRepository.findById(credential.agentId)`, done as two
 * queries rather than one because **there is no FK** between the two tables
 * — `AgentCredentialsService.create`'s own docstring says why: the very
 * first credential for a brand-new agent is created before an `agents` row
 * exists at all. So the join can miss, and a miss is treated exactly like an
 * unknown token (`MCP_CREDENTIAL_INVALID`), never a 404 — a 404 would let an
 * id be used to probe whether it exists. The same refusal covers the rarer
 * case of a credential naming an agent that exists but belongs to a
 * *different* organization than the credential itself: with no FK to enforce
 * it, that is a corrupt reference, not a valid session, and treating it as
 * anything else would let a session's `organizationId` and `agentId` name two
 * different tenants.
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
 *
 * ## The refusals that are not `MCP_CREDENTIAL_INVALID`
 *
 * A suspended agent and an agent with no linked wallet are facts about a
 * caller already identified by a genuine credential — exactly the reasoning
 * `PrivyMcpSessionSource` and `auth.errors.ts` give for `AUTH_AGENT_SUSPENDED`
 * and `AUTH_WALLET_NOT_LINKED` over a generic 401. `CompositeMcpSessionSource`
 * lets both propagate rather than trying the next source.
 */
@Injectable()
export class DbCredentialMcpSessionSource implements McpSessionPort {
  constructor(
    private readonly credentials: AgentCredentialRepository,
    private readonly agents: AgentRepository,
  ) {}

  async resolve(bearerToken: string | null): Promise<McpSession> {
    if (!bearerToken || !bearerToken.startsWith(AGENT_CREDENTIAL_TOKEN_PREFIX)) {
      throw McpErrors.credentialInvalid();
    }

    const credential = await this.credentials.findByTokenHash(digestToken(bearerToken));
    if (!credential || isInactive(credential)) {
      throw McpErrors.credentialInvalid();
    }

    const agent = await this.agents.findById(credential.agentId);
    if (!agent || agent.organizationId !== credential.organizationId) {
      throw McpErrors.credentialInvalid();
    }

    if (agent.status === SUSPENDED) {
      throw AuthErrors.agentSuspended();
    }

    if (!agent.primaryAccountId || !agent.chainId) {
      throw AuthErrors.walletNotLinked();
    }

    // Fire-and-forget, and scoped: `update({ id }, …)` alone throws
    // `ORGANIZATION_SCOPE_MISSING`, and a bare `.catch(() => {})` would
    // swallow that rejection silently — the column would never be written,
    // behind a suite that stays green. `organizationId` has to be in the
    // criteria for the write to ever land.
    void this.credentials
      .update(
        { organizationId: credential.organizationId, id: credential.id },
        { lastUsedAt: new Date() },
      )
      .catch(() => {
        // Best-effort — see `AgentCredentialEntity.lastUsedAt`. A failed
        // stamp must never turn a successful authentication into a refusal.
      });

    return {
      credentialId: credential.id,
      organizationId: credential.organizationId,
      agentId: agent.id,
      agentAccount: agent.primaryAccountId as AccountId,
      chainId: agent.chainId as ChainId,
      label: agent.label,
    };
  }
}

function isInactive(credential: AgentCredentialEntity): boolean {
  if (credential.revokedAt) return true;
  if (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()) return true;
  return false;
}
