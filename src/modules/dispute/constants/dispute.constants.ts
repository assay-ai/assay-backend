/**
 * The dispute response window.
 *
 * 72 hours, and the clock starts on **acknowledgement**, never on `createdAt`.
 * A fixed window that can include a weekend and a dead webhook is not a
 * due-process window; see
 * `DisputeEntity`'s class comment and `chk_disputes_deadline_needs_ack`.
 */
export const DISPUTE_RESPONSE_WINDOW_HOURS = 72;
