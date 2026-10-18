import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `AUTH_*` — the refusals that happen **after** a token has already been
 * proven genuine.
 *
 * ## Why there is no `AUTH_TOKEN_INVALID` here
 *
 * Every way a Privy access token can fail to verify — missing, malformed,
 * wrong algorithm, unknown key, bad signature, expired, wrong issuer, wrong
 * audience — raises `MCP_CREDENTIAL_INVALID`, the code
 * `ConfigMcpSessionSource` already raises, with the same 401 and the same
 * message. Two reasons, and both matter:
 *
 * 1. **`McpSessionPort`'s contract says so.** Its docstring: *"A missing token
 *    and an unknown token are both `MCP_CREDENTIAL_INVALID`, deliberately
 *    indistinguishable from outside."* An implementation of that port does not
 *    get to publish a finer-grained answer, and an error that distinguished
 *    "bad signature" from "expired" from "wrong audience" is an oracle — it
 *    tells someone probing exactly which half of a forgery to fix next.
 * 2. **The two sources must be indistinguishable.** With both a config token
 *    and a Privy token acceptable, a distinct code per source would tell an
 *    unauthenticated caller which issuer a deployment trusts.
 *
 * The codes below are the opposite situation: the token verified, we know
 * exactly who the caller is, and the refusal is a fact about *them* rather
 * than about their secret. Those are safe to name, and expensive to hide — a
 * 401 for "your wallet is not linked yet" sends someone to re-authenticate
 * over and over against a problem that has nothing to do with their token.
 */
export enum AuthErrorCode {
  AUTH_AGENT_SUSPENDED = 'AUTH_AGENT_SUSPENDED',
  AUTH_ORGANIZATION_SUSPENDED = 'AUTH_ORGANIZATION_SUSPENDED',
  AUTH_WALLET_NOT_LINKED = 'AUTH_WALLET_NOT_LINKED',
  AUTH_PROVISIONING_FAILED = 'AUTH_PROVISIONING_FAILED',
  AUTH_IDENTITY_PROVIDER_UNAVAILABLE = 'AUTH_IDENTITY_PROVIDER_UNAVAILABLE',
  AUTH_HUMAN_SESSION_REQUIRED = 'AUTH_HUMAN_SESSION_REQUIRED',
  AUTH_CLIENT_NOT_ALLOWED_HERE = 'AUTH_CLIENT_NOT_ALLOWED_HERE',
}

export type AuthErrorCodesArePrefixed = AssertDomainErrorCodes<'AUTH', `${AuthErrorCode}`>;

export const AuthErrors = createDomainErrorFactory('AUTH', {
  /**
   * A genuine token for an agent whose row says `SUSPENDED`. 403, not 401:
   * the credential is fine and re-authenticating will not help.
   */
  agentSuspended: {
    code: AuthErrorCode.AUTH_AGENT_SUSPENDED,
    statusCode: 403,
    message: () => 'This agent is suspended',
  },

  /** The tenant is suspended, whatever the agent's own status says. */
  organizationSuspended: {
    code: AuthErrorCode.AUTH_ORGANIZATION_SUSPENDED,
    statusCode: 403,
    message: () => 'This organization is suspended',
  },

  /**
   * Authenticated, provisioned, and no CAIP-10 account to spend from.
   *
   * `McpSession.agentAccount` is the account a call is charged to and a
   * withdrawal is authorised against. There is one honest source for it — a
   * wallet the human actually controls — and until one is linked there is
   * nothing to put there. 424 rather than 403: nothing is forbidden, a
   * dependency is missing, and the fix is an action the caller can take.
   */
  walletNotLinked: {
    code: AuthErrorCode.AUTH_WALLET_NOT_LINKED,
    statusCode: 424,
    message: () => 'No wallet is linked to this account yet',
  },

  /**
   * The identity verified but the organization/agent pair could not be
   * created or re-read — a lost race that did not resolve, or a database
   * failure during provisioning. 503 because it is ours, not theirs, and
   * retrying is the correct client behaviour.
   */
  provisioningFailed: {
    code: AuthErrorCode.AUTH_PROVISIONING_FAILED,
    statusCode: 503,
    message: () => 'Could not provision this account; retry shortly',
  },

  /**
   * No usable signing key: the JWKS could not be fetched and nothing cached
   * is still inside its stale grace window.
   *
   * **This is the fail-closed branch, and it is not an oracle.** It says
   * nothing about the presented token — a forged one and a perfect one get
   * the identical answer, because neither was checked. It is a 503 rather
   * than a 401 so that an outage at the identity provider reads as an outage
   * in the dashboard instead of as a credential-stuffing wave.
   */
  /**
   * A genuine agent machine credential on a route that changes the controls
   * over that agent — its spend policy, its credentials, where its alerts go.
   *
   * 403, not 401: the credential is valid and re-authenticating with it will
   * not help. The limits exist to bound the agent, so the agent holding the
   * bearer token must not be able to lift them; a person signed in to the
   * dashboard makes these changes.
   */
  humanSessionRequired: {
    code: AuthErrorCode.AUTH_HUMAN_SESSION_REQUIRED,
    statusCode: 403,
    message: () => 'This change needs a signed-in user; an agent credential cannot make it',
  },

  /**
   * A genuine OAuth access token, presented to the API app by a client outside
   * `OAUTH_PAYMENT_CLIENTS` (R-OA-21). Such grants serve the MCP host only.
   * 403, not 401: the token is fine where it belongs.
   */
  clientNotAllowedHere: {
    code: AuthErrorCode.AUTH_CLIENT_NOT_ALLOWED_HERE,
    statusCode: 403,
    message: () => 'This app is connected for MCP calls only; it cannot use this API',
  },

  identityProviderUnavailable: {
    code: AuthErrorCode.AUTH_IDENTITY_PROVIDER_UNAVAILABLE,
    statusCode: 503,
    message: () => 'Authentication is temporarily unavailable',
  },
});
