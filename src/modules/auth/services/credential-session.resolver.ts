import { Injectable, Optional } from '@nestjs/common';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { LastSeenKind, LastSeenRecorder, credentialKey } from '@shared/last-seen';

import { AuthErrors } from '../errors/auth.errors';

const ACTIVE = 'ACTIVE';

/**
 * An `agent_credentials` row, already found, resolved to a session.
 *
 * Every source that authenticates a stored credential — an API key looked up
 * by its hash, or an OAuth access token that names its credential — ends
 * here, so the two cannot drift: the same row yields the same session through
 * the same checks. The only input a source chooses is `paymentsAllowed`
 * (spec §6.3.13). Nothing here reads how the row was issued.
 *
 * Callers must pass only a row they found by authenticating a presented
 * secret (an API key's hash, an OAuth access token), never one looked up by
 * an id from the request: this mints a full session from whatever row it is
 * given.
 *
 * ## `agentAccount` and `chainId` come from `agents`, not from the credential
 *
 * `agent_credentials` has neither column — same reason `PrivyMcpSessionSource`
 * reads them from `agents` rather than the token: they name the account a
 * call is charged to, and the one honest source for that is the row a wallet
 * was actually linked to, not anything a caller-controlled artefact carries.
 * The join is `AgentRepository.findByIdWithOrganization(credential.agentId)`
 * (which also reads the organization's status), a second query rather than
 * part of the first because **there is no FK** between the two tables.
 * `AgentCredentialsService.create` refuses an agent that does not exist, but
 * rows minted before that check (or by scripts) can still name one, so the
 * join can miss, and a miss is treated exactly like an
 * unknown token (`MCP_CREDENTIAL_INVALID`), never a 404 — a 404 would let an
 * id be used to probe whether it exists. The same refusal covers the rarer
 * case of a credential naming an agent that exists but belongs to a
 * *different* organization than the credential itself: with no FK to enforce
 * it, that is a corrupt reference, not a valid session, and treating it as
 * anything else would let a session's `organizationId` and `agentId` name two
 * different tenants.
 *
 * ## The refusals that are not `MCP_CREDENTIAL_INVALID`
 *
 * A suspended organization, a suspended agent and an agent with no linked
 * wallet are facts about a caller already identified by a genuine
 * credential — exactly the reasoning `PrivyMcpSessionSource` and
 * `auth.errors.ts` give for `AUTH_ORGANIZATION_SUSPENDED`,
 * `AUTH_AGENT_SUSPENDED` and `AUTH_WALLET_NOT_LINKED` over a generic 401.
 * `CompositeMcpSessionSource` lets all three propagate rather than trying the
 * next source.
 */
@Injectable()
export class CredentialSessionResolver {
  constructor(
    private readonly credentials: AgentCredentialRepository,
    private readonly agents: AgentRepository,
    @Optional() private readonly lastSeen: LastSeenRecorder | null = null,
  ) {}

  async sessionFor(
    credential: AgentCredentialEntity,
    opts: { paymentsAllowed: boolean },
  ): Promise<McpSession> {
    if (isInactive(credential)) {
      throw McpErrors.credentialInvalid();
    }

    const found = await this.agents.findByIdWithOrganization(credential.agentId);
    const agent = found?.agent;
    if (!agent || agent.organizationId !== credential.organizationId) {
      throw McpErrors.credentialInvalid();
    }

    // The same two checks, in the same order, as `PrivyMcpSessionSource`:
    // suspending the organization must stop its machine credentials too, and
    // only ACTIVE passes, so a status added later is refused by default.
    if (found.organizationStatus !== ACTIVE) {
      throw AuthErrors.organizationSuspended();
    }

    if (agent.status !== ACTIVE) {
      throw AuthErrors.agentSuspended();
    }

    if (!agent.primaryAccountId || !agent.chainId) {
      throw AuthErrors.walletNotLinked();
    }

    this.stampUse(credential);

    return {
      credentialId: credential.id,
      storedCredential: true,
      organizationId: credential.organizationId,
      agentId: agent.id,
      agentAccount: agent.primaryAccountId as AccountId,
      chainId: agent.chainId as ChainId,
      label: agent.label,
      callerKind: McpCallerKind.AGENT,
      delegateAccount: (credential.delegateAccount as AccountId | null) ?? null,
      paymentsAllowed: opts.paymentsAllowed,
    };
  }

  /**
   * `last_used_at`, fire-and-forget. Buffered by `LastSeenRecorder` (one
   * batched write every 30 s instead of one per request); without it, the
   * direct write it replaces. Scoped either way: `update({ id }, …)` alone
   * throws `ORGANIZATION_SCOPE_MISSING`, and a bare `.catch(() => {})` would
   * swallow that rejection silently, so `organizationId` is in the criteria.
   */
  stampUse(credential: Pick<AgentCredentialEntity, 'organizationId' | 'id'>): void {
    if (this.lastSeen) {
      this.lastSeen.record(
        LastSeenKind.CREDENTIAL_USE,
        credentialKey(credential.organizationId, credential.id),
      );
      return;
    }
    void this.credentials
      .update(
        { organizationId: credential.organizationId, id: credential.id },
        { lastUsedAt: new Date() },
      )
      .catch(() => {
        // Best-effort — see `AgentCredentialEntity.lastUsedAt`. A failed
        // stamp must never turn a successful authentication into a refusal.
      });
  }
}

function isInactive(credential: AgentCredentialEntity): boolean {
  if (credential.revokedAt) return true;
  if (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()) return true;
  return false;
}
