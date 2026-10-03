import { AccountId, ChainId } from '@modules/chains/ports/caip.types';

/**
 * Who is calling, resolved from the bearer token.
 *
 * The token is meant to be a Privy-issued session token identifying the agent
 * and carrying its spend policy. That issuer does not exist yet, so what is behind this
 * port today is a configuration file — the same arrangement as
 * `ConfigProviderRegistry` and for the same reason: the thing that needs it
 * shipped first.
 *
 * What the port fixes now, and what the swap must preserve, is the **shape of
 * the claim**: a token names an organization, an agent, and the account whose
 * balance the call spends. Every one of those is read from here and never from
 * the request — an agent that could name its own `agentAccount` in a tool call
 * would be spending somebody else's balance.
 */
export interface McpSession {
  /**
   * The credential the caller presented, by id — never the token itself.
   *
   * Present so a log line, a rate limit or a revocation can name the credential
   * without the secret travelling with it.
   */
  readonly credentialId: string;

  readonly organizationId: string;
  readonly agentId: string;
  /** CAIP-10. The ledger account this session's calls are charged to. */
  readonly agentAccount: AccountId;
  /** CAIP-2. Which chain the resulting intents settle on. */
  readonly chainId: ChainId;

  /** Human label for logs and the dashboard. Never authorisation. */
  readonly label: string | null;
}

/**
 * Resolve a bearer token, or refuse.
 *
 * **Fails closed by throwing.** There is no "anonymous session": the return
 * type has no null branch precisely so that no caller can accidentally treat an
 * unauthenticated request as a cheap one and let it through to a code path that
 * spends money. A missing token and an unknown token are both
 * `MCP_CREDENTIAL_INVALID`, deliberately indistinguishable from outside.
 */
export interface McpSessionPort {
  resolve(bearerToken: string | null): Promise<McpSession>;
}

/** DI token for the bound {@link McpSessionPort}. */
export const MCP_SESSION_SOURCE = 'MCP_SESSION_SOURCE';
