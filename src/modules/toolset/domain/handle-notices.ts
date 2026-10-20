import {
  NotificationEvent,
  NotificationRequest,
} from '@modules/notification/ports/notification.port';

/**
 * What a handle's owner is told when an operator takes its public name down
 * (`A-17`), and when that takedown is rejected, lifted or lapses. One notice
 * per handle — its provider tools stop and resume with it, and are not told
 * one by one. The operator's note is never in it. Pure.
 */
export function handleNotification(notice: {
  readonly kind: 'TAKEN_DOWN' | 'TAKEDOWN_LIFTED';
  readonly organizationId: string;
  readonly handle: string;
}): NotificationRequest {
  const base = {
    organizationId: notice.organizationId,
    subjectType: 'handle',
    subjectId: notice.handle,
    payload: { handle: notice.handle },
  };
  return notice.kind === 'TAKEN_DOWN'
    ? {
        ...base,
        event: NotificationEvent.HANDLE_TAKEN_DOWN,
        title: `Your public name @${notice.handle} was taken down`,
        body:
          `An operator took @${notice.handle} down. Every URL under it stops, and so do your ` +
          'provider tools. Contact support if you think this is a mistake.',
      }
    : {
        ...base,
        event: NotificationEvent.HANDLE_TAKEDOWN_LIFTED,
        title: `The takedown of @${notice.handle} was lifted`,
        body: `@${notice.handle} and the tools under it serve again.`,
      };
}
