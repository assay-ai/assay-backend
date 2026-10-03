/**
 * The `notifications.subject_type` a slash proposal is filed under.
 *
 * Shared rather than written twice on purpose. `SlashProposalService.notify`
 * stamps it onto the notification and `SlashDeliveryObserver` matches on it to
 * decide whether a delivery starts the provider's response clock. If the two
 * spellings ever drifted, `markDelivered` would silently stop being called —
 * no error, no log, just `respond_by_at` staying null and no proposal ever
 * reaching `UPHELD` again. That failure has happened before, so it is not left
 * reachable by a typo.
 */
export const SLASH_PROPOSAL_SUBJECT_TYPE = 'slash_proposal';
