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
export const AGENT_CREDENTIAL_TOKEN_PREFIX = 'x402_sk_live_';

/**
 * How much of the token is stored in clear for disambiguation.
 * `agent_credentials.prefix` is `varchar(24)`; this must not exceed it.
 */
export const AGENT_CREDENTIAL_STORED_PREFIX_LENGTH = 20;
