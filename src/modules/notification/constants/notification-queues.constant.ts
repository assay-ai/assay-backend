/**
 * Queue names owned by the notification module.
 *
 * Naming convention: `<entity>.<verb>` in kebab-case. See `docs/architecture.md`.
 */
export enum NotificationQueue {
  /**
   * One job per `(notification, channel)` delivery attempt, for every
   * non-`IN_APP` channel a fan-out left `PENDING`. `IN_APP` never reaches this
   * queue — its delivery row is written `DELIVERED` synchronously, because the
   * row itself is the delivery.
   *
   * `bullmq.config.ts`'s own comment names this queue by example: *"stateless
   * idempotent jobs (notifications, sync, etc.) override per-publisher with
   * `attempts: 3` + exponential backoff."* A retried delivery re-sends through
   * a channel that is, at worst, a duplicate log line today — there is no
   * vendor call yet to double-charge or double-page on.
   */
  DELIVER = 'notification.deliver',
}
