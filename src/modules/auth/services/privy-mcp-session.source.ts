import { Injectable } from '@nestjs/common';

import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpCallerKind, McpSession, McpSessionPort } from '@modules/mcp/ports/mcp-session.port';

import { AuthErrors } from '../errors/auth.errors';
import { AgentProvisioningService } from './agent-provisioning.service';
import { PrivyTokenVerifier } from './privy-token.verifier';

const ACTIVE = 'ACTIVE';

/**
 * The real thing `ConfigMcpSessionSource` has been standing in for.
 *
 * `ConfigMcpSessionSource` is a stand-in for Privy-issued session tokens, not
 * because a JSON file is a reasonable place to keep credentials. This class is
 * the replacement, and
 * it deliberately implements the same port rather than introducing a second
 * notion of who is calling — `SessionAuthGuard`, `McpController` and every
 * controller reading `@CurrentSession()` are unchanged, because the contract
 * they depend on is `McpSessionPort.resolve` and that is what was being swapped
 * out all along.
 *
 * ## What the token is allowed to decide, and what it is not
 *
 * The token decides one thing: **which Privy identity** is calling. Everything
 * else on the session — the organization, the agent, the account whose balance
 * is spent, the chain it settles on — is read from our own tables, keyed by
 * that identity. That is the invariant `McpSessionPort` was written around:
 * *"an agent that could name its own `agentAccount` in a tool call would be
 * spending somebody else's balance."* A Privy token carries no such claims, and
 * if a future one did, nothing here would read them.
 *
 * ## Every unverifiable token is the same 401
 *
 * Missing, malformed, wrong algorithm, unknown key, bad signature, expired,
 * wrong issuer, wrong audience — all of it is `MCP_CREDENTIAL_INVALID`, the
 * identical code, status and message `ConfigMcpSessionSource` raises.
 * `PrivyTokenVerifier` makes that structural by having exactly one negative
 * return value, so there is no branch here that *could* say more. See
 * `auth.errors.ts` for why an error that distinguished them would be an oracle.
 *
 * ## The refusals that are not 401
 *
 * A suspended agent, a suspended organization, and an identity with no wallet
 * linked yet are facts about a caller we have already identified, not about
 * their secret. Collapsing those into 401 would send someone re-authenticating
 * forever against a problem their token cannot fix.
 */
@Injectable()
export class PrivyMcpSessionSource implements McpSessionPort {
  constructor(
    private readonly verifier: PrivyTokenVerifier,
    private readonly provisioning: AgentProvisioningService,
  ) {}

  async resolve(bearerToken: string | null): Promise<McpSession> {
    if (!bearerToken) {
      throw McpErrors.credentialInvalid();
    }

    const claims = await this.verifier.verify(bearerToken);
    if (!claims) {
      throw McpErrors.credentialInvalid();
    }

    const { agent, organizationStatus } = await this.provisioning.resolve(claims);

    if (organizationStatus !== ACTIVE) {
      throw AuthErrors.organizationSuspended();
    }

    if (agent.status !== ACTIVE) {
      throw AuthErrors.agentSuspended();
    }

    if (!agent.primaryAccountId || !agent.chainId) {
      throw AuthErrors.walletNotLinked();
    }

    return {
      // Privy's session id where the token carries one: it names *which* login
      // is calling without the token itself ever travelling, which is exactly
      // what `credentialId` is for. The DID is the fallback — still an
      // identifier, still not a secret.
      credentialId: claims.sessionId ?? claims.subject,
      organizationId: agent.organizationId,
      agentId: agent.id,
      agentAccount: agent.primaryAccountId as AccountId,
      chainId: agent.chainId as ChainId,
      label: agent.label,
      callerKind: McpCallerKind.HUMAN,
      paymentsAllowed: true,
    };
  }
}
