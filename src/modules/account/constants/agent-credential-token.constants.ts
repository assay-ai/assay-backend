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

/**
 * The prefix keys were issued with before the rename to `assay_`. Still
 * accepted so existing keys keep working; delete it once they are rotated.
 */
export const LEGACY_AGENT_CREDENTIAL_TOKEN_PREFIX = 'x402_sk_live_';

/** Whether a bearer token has the shape of one of our agent keys. */
export function isAgentCredentialToken(token: string): boolean {
  return (
    token.startsWith(AGENT_CREDENTIAL_TOKEN_PREFIX) ||
    token.startsWith(LEGACY_AGENT_CREDENTIAL_TOKEN_PREFIX)
  );
}

/**
 * How much of the token is stored in clear for disambiguation.
 * `agent_credentials.prefix` is `varchar(24)`; this must not exceed it.
 */
export const AGENT_CREDENTIAL_STORED_PREFIX_LENGTH = 20;
