/**
 * The shape of an agent credential token.
 *
 * It lives here rather than beside the generator because two modules need it
 * for opposite reasons: `account` writes tokens with this prefix, and `auth`
 * reads it to decide whether a presented bearer token is one of ours at all.
 *
 * That read is load-bearing. `CompositeMcpSessionSource` advances to the next
 * source only on `MCP_CREDENTIAL_INVALID`, so the credential source has to
 * recognise "not mine" from the prefix alone and refuse cheaply — otherwise it
 * swallows Privy's JWTs and no later source ever runs.
 */
export const AGENT_CREDENTIAL_TOKEN_PREFIX = 'assay_sk_live_';

/** Whether a bearer token has the shape of one of our agent keys. */
export function isAgentCredentialToken(token: string): boolean {
  return token.startsWith(AGENT_CREDENTIAL_TOKEN_PREFIX);
}

/** How many trailing characters of a token are stored in clear (`agent_credentials.token_last4`). */
export const AGENT_CREDENTIAL_HINT_LENGTH = 4;

/** The trailing characters kept for a new token: never more than {@link AGENT_CREDENTIAL_HINT_LENGTH}. */
export function agentCredentialLast4(token: string): string {
  return token.slice(-AGENT_CREDENTIAL_HINT_LENGTH);
}

/**
 * What a key list shows to recognise a key: `assay_sk_live_…2fds`. `null`
 * when nothing is stored (an OAuth grant, or a key created before the column).
 */
export function agentCredentialHint(last4: string | null | undefined): string | null {
  return last4 ? `${AGENT_CREDENTIAL_TOKEN_PREFIX}…${last4}` : null;
}
