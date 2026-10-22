import { SetMetadata } from '@nestjs/common';

/**
 * What an agent credential (an API key or an OAuth grant) may do. A closed
 * list: a route accepts an agent credential only when it names one of these
 * with {@link RequireAgentScope}, and the credential holds it.
 *
 * - `tools:call`: list, search and call tools on the MCP host; read its own
 *   free quota and tool access.
 * - `payments`: take part in paid calls (bind a payment key, issue voucher
 *   seqs, settle its own debts). Without it a session is free-only, exactly
 *   like a third-party OAuth grant.
 * - `activity:read`: read its own money and activity (balance, calls,
 *   receipts, verdicts, spend policy, its own bad-result reports).
 * - `reports:write`: report a bad result, or withdraw a report.
 *
 * A person's session is not limited by scopes. Everything a route does not
 * open with a scope is a person's only, whatever scopes a key holds.
 */
export enum AgentScope {
  TOOLS_CALL = 'tools:call',
  PAYMENTS = 'payments',
  ACTIVITY_READ = 'activity:read',
  REPORTS_WRITE = 'reports:write',
}

export const AGENT_SCOPES: readonly AgentScope[] = Object.freeze(Object.values(AgentScope));

/** A new API key, and a grant of the first-party `assay-mcp` client. */
export const DEFAULT_AGENT_SCOPES: readonly AgentScope[] = Object.freeze([
  AgentScope.TOOLS_CALL,
  AgentScope.PAYMENTS,
  AgentScope.ACTIVITY_READ,
]);

/** A grant of any other OAuth client: free tool calls only (owner decision H2). */
export const THIRD_PARTY_OAUTH_SCOPES: readonly AgentScope[] = Object.freeze([
  AgentScope.TOOLS_CALL,
]);

export function isAgentScope(value: unknown): value is AgentScope {
  return typeof value === 'string' && (AGENT_SCOPES as readonly string[]).includes(value);
}

/**
 * The scopes a stored row grants. A value outside the vocabulary grants
 * nothing; the row is never trusted to define a new power.
 */
export function agentScopesOf(stored: readonly string[] | null | undefined): AgentScope[] {
  return AGENT_SCOPES.filter((scope) => (stored ?? []).includes(scope));
}

/** The OAuth grant's scopes, by whether its client may take part in paid calls. */
export function oauthGrantScopes(paymentClient: boolean): readonly AgentScope[] {
  return paymentClient ? DEFAULT_AGENT_SCOPES : THIRD_PARTY_OAUTH_SCOPES;
}

export const AGENT_SCOPE_METADATA = 'agentScope';

/**
 * Opens a route to an agent credential that holds `scope`. Without it, a
 * route under `SessionAuthGuard` is a person's only (deny by default), so a
 * new route fails closed.
 */
export const RequireAgentScope = (scope: AgentScope) => SetMetadata(AGENT_SCOPE_METADATA, scope);
