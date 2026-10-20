import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `OAUTH_*` — the consent API's refusals (`{API}/oauth/requests/{rid}…`).
 *
 * The OAuth protocol endpoints on `{MCP}` (`/oauth/authorize`, `/token`,
 * `/register`, `/revoke`) answer in RFC 6749 error shape (`invalid_grant`, …),
 * not with these codes: a third-party client parses those, not ours.
 *
 * No message names a request id, a code or a token (R-OA-27).
 */
export enum OAuthErrorCode {
  OAUTH_REQUEST_NOT_FOUND = 'OAUTH_REQUEST_NOT_FOUND',
  OAUTH_REQUEST_ALREADY_DECIDED = 'OAUTH_REQUEST_ALREADY_DECIDED',
  OAUTH_AGENT_NOT_ACTIVE = 'OAUTH_AGENT_NOT_ACTIVE',
  OAUTH_GRANT_LIMIT_REACHED = 'OAUTH_GRANT_LIMIT_REACHED',
  OAUTH_CREDENTIAL_NAME_INVALID = 'OAUTH_CREDENTIAL_NAME_INVALID',
  OAUTH_REQUEST_STORE_UNAVAILABLE = 'OAUTH_REQUEST_STORE_UNAVAILABLE',
  OAUTH_REPLACE_AGENT_MISMATCH = 'OAUTH_REPLACE_AGENT_MISMATCH',
}

export type OAuthErrorCodesArePrefixed = AssertDomainErrorCodes<'OAUTH', `${OAuthErrorCode}`>;

export const OAuthErrors = createDomainErrorFactory('OAUTH', {
  /** Unknown, expired, or another browser's request — indistinguishable on purpose. */
  requestNotFound: {
    code: OAuthErrorCode.OAUTH_REQUEST_NOT_FOUND,
    statusCode: 404,
    message: () => 'This sign-in request was not found or has expired; start again from the app',
  },
  /** Approved or denied already; a request is decided once. */
  requestAlreadyDecided: {
    code: OAuthErrorCode.OAUTH_REQUEST_ALREADY_DECIDED,
    statusCode: 409,
    message: () => 'This sign-in request was already approved or denied',
  },
  /**
   * The agent is suspended, its organization is suspended, or it has no linked
   * wallet (R-OA-32). 409: the request is well formed, the agent's state stops it.
   */
  agentNotActive: {
    code: OAuthErrorCode.OAUTH_AGENT_NOT_ACTIVE,
    statusCode: 409,
    message: () => 'This agent cannot be connected now: it is suspended or has no linked wallet',
  },
  /** The agent already has the maximum of live OAuth credentials (R-OA-31). */
  grantLimitReached: {
    code: OAuthErrorCode.OAUTH_GRANT_LIMIT_REACHED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This agent already has ${context?.limit ?? 'the maximum number of'} connected apps; ` +
      'disconnect one before adding another',
  },
  /**
   * A re-login (`assay_replaces`) names a live connection of another agent
   * than the one chosen. The re-login replaces that agent's connection, or the
   * old one would keep the payment key and the new one could not bind it.
   */
  replaceAgentMismatch: {
    code: OAuthErrorCode.OAUTH_REPLACE_AGENT_MISMATCH,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This sign-in replaces ${context?.agentName ?? 'another agent'}'s connection. ` +
      'Sign out first to connect another agent.',
  },
  /** The pending-request store (Redis) failed or did not answer in time. */
  requestStoreUnavailable: {
    code: OAuthErrorCode.OAUTH_REQUEST_STORE_UNAVAILABLE,
    statusCode: 503,
    message: () => 'Sign-in is temporarily unavailable; try again in a moment',
  },
  /**
   * The connection's name is empty, or nothing but control, format or
   * invisible characters, once those are stripped.
   */
  credentialNameInvalid: {
    code: OAuthErrorCode.OAUTH_CREDENTIAL_NAME_INVALID,
    statusCode: 400,
    message: () => 'Give this connection a name with at least one letter or digit',
  },
});
