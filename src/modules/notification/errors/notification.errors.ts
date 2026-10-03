import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `NOTIFICATION_*` — the settings surface over `notification_channels` and
 * `notification_preferences`.
 */
export enum NotificationErrorCode {
  NOTIFICATION_NONSUPPRESSIBLE_EVENT = 'NOTIFICATION_NONSUPPRESSIBLE_EVENT',
  NOTIFICATION_NOT_FOUND = 'NOTIFICATION_NOT_FOUND',
}

export type NotificationErrorCodesArePrefixed = AssertDomainErrorCodes<
  'NOTIFICATION',
  `${NotificationErrorCode}`
>;

export const NotificationErrors = createDomainErrorFactory('NOTIFICATION', {
  /**
   * `NOTIFICATION_CATALOGUE[event].nonSuppressible` refuses this at the
   * service, not just at the DTO — every withdrawal event, destination
   * addition, and the two provider consent/stake-loss paths cannot be muted by
   * any preference row, per that catalogue's own class comment.
   */
  nonSuppressibleEvent: {
    code: NotificationErrorCode.NOTIFICATION_NONSUPPRESSIBLE_EVENT,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `${context?.event ?? 'This event'} cannot be disabled on ${context?.channel ?? 'this channel'} — it is on the account-takeover/consent list`,
  },
  /** Cross-organization id, or no such row — the two are indistinguishable on purpose. */
  notFound: {
    code: NotificationErrorCode.NOTIFICATION_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Notification not found${context?.id ? ` with id: ${context.id}` : ''}`,
  },
});
