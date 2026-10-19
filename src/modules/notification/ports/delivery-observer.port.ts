/** DI token for {@link DeliveryObserverPort}. */
export const DELIVERY_OBSERVER = 'DELIVERY_OBSERVER';

/**
 * Told when a channel has actually delivered a notification.
 *
 * ## Why a port and not a direct call
 *
 * The one consumer today is the slash case: `notified_at` is set by
 * `SlashProposalService.markDelivered`, and the propose sweep reserves no stake
 * on chain for a case whose provider was never told about it.
 *
 * `notification` must not import `slash`: the dependency already runs the other
 * way (`SlashOpenerModule` imports `NotificationModule` to raise
 * `PROVIDER_SLASH_PROPOSED`), and a direct import would close the cycle. There
 * is no event bus in this codebase to use instead — `EventEmitter2`/`@OnEvent`
 * appear nowhere — so a port token is the mechanism, bound by the module that
 * owns the worker.
 *
 * ## Why delivery and not dispatch
 *
 * A message that is only *queued* is a message nobody received. This is
 * called from the deliver processor, after a sender reports success, so the
 * delivery is recorded on the same event the provider could have seen. `IN_APP` is a real sender (`InAppChannelSender`); the other
 * channels are still `LoggingChannelSender`, and a log line does not report a
 * delivery it did not make — it reports the one it did, into a log the operator
 * reads, which is the honest meaning available today.
 *
 * ## Contract
 *
 * Implementations **must not throw**. The caller is a queue processor whose
 * job has already succeeded by the time this runs; turning an observer failure
 * into a job failure would retry a delivery that already happened.
 *
 * Implementations **must be idempotent**. Two channels delivering the same
 * notification call this twice, and the delivery is recorded once.
 */
export interface DeliveryObserverPort {
  /**
   * @param subjectType the notification's subject kind, e.g. `slash_proposal`.
   *        Observers that do not recognise it must return without acting.
   * @param subjectId   the row the notification was about.
   * @param deliveredAt when the channel reported success.
   */
  onDelivered(
    organizationId: string,
    subjectType: string,
    subjectId: string,
    deliveredAt: Date,
  ): Promise<void>;
}
