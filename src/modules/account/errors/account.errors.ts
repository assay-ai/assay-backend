import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `ACCOUNT_*` — the buyer-side account surface: notifications, the
 * audit log, agents, and agent credentials.
 *
 * The audit log has no write endpoint (it is append-only, read through this
 * module only) and agents have no lookup-shaped error at all — there is no
 * `agents` table, so an unrecognised `agentId` is not a 404, it is a filter
 * that matches nothing. See `AgentsService` / `AgentCredentialsService`.
 */
export enum AccountErrorCode {
  ACCOUNT_NOTIFICATION_NOT_FOUND = 'ACCOUNT_NOTIFICATION_NOT_FOUND',
  ACCOUNT_CREDENTIAL_NOT_FOUND = 'ACCOUNT_CREDENTIAL_NOT_FOUND',
}

export type AccountErrorCodesArePrefixed = AssertDomainErrorCodes<'ACCOUNT', `${AccountErrorCode}`>;

export const AccountErrors = createDomainErrorFactory('ACCOUNT', {
  /** Cross-organization id, or no such row at all — the two are indistinguishable on purpose. */
  notificationNotFound: {
    code: AccountErrorCode.ACCOUNT_NOTIFICATION_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Notification not found${context?.id ? ` with id: ${context.id}` : ''}`,
  },
  /**
   * Also raised when the credential exists but under a different `agentId`
   * than the one in the route — a routing mismatch is not a 403, it is "no
   * such credential under this agent", which is a 404 for the same reason a
   * cross-organization id is.
   */
  credentialNotFound: {
    code: AccountErrorCode.ACCOUNT_CREDENTIAL_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Agent credential not found${context?.id ? ` with id: ${context.id}` : ''}`,
  },
});
