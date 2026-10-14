import type { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
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

  /**
   * What kind of credential this is — a person, or a machine acting for one.
   *
   * Set by the source that resolved the token and never read from the
   * request. Every source maps to one session shape, so without this no route
   * could tell a human's dashboard session from the agent's own bearer token,
   * and an agent could rewrite the limits that exist to bound it. Routes that
   * change those controls refuse {@link McpCallerKind.AGENT} with
   * `HumanSessionGuard`.
   */
  readonly callerKind: McpCallerKind;

  /**
   * The DELEGATE key bound to this agent credential (CAIP-10), once the agent
   * proved it holds it — agent payment delegation on eip155. A rail-B voucher
   * signed by a delegate is accepted only from the credential bound to that
   * key, and PAYMENT_REQUIRED names it. Absent or null for every other source.
   */
  readonly delegateAccount?: AccountId | null;

  /**
   * Set when the caller's organization, account or delegate is on the
   * account blocklist and the caller is a person (`HUMAN` or `CONFIG`).
   *
   * A blocked machine credential never gets a session at all. A blocked person
   * does, so the dashboard can still read the account's own data and show why
   * it is blocked; `SessionAuthGuard` refuses every non-read route for such a
   * session, and the MCP endpoint refuses it outright. Absent on every other
   * session.
   */
  readonly blocked?: SessionBlock | null;
}

/** Which party of a session is blocked. */
export interface SessionBlock {
  readonly role: BlockedRole;
  readonly subjectKind: BlockSubjectKind;
}

/** Who presented the credential behind an {@link McpSession}. */
export enum McpCallerKind {
  /** A Privy access token — a person signed in to the dashboard. */
  HUMAN = 'HUMAN',
  /** An agent machine credential (`assay_sk_live_…`, `agent_credentials`). */
  AGENT = 'AGENT',
  /**
   * A token from `MCP_CREDENTIALS_FILE`. The config file stands in for the
   * human login it predates — tests, local stacks and `yarn demo:seed` drive
   * the dashboard with these — so it is treated as a human session.
   */
  CONFIG = 'CONFIG',
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
