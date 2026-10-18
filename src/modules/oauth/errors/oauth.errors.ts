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
});
