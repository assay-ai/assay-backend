import { SetMetadata } from '@nestjs/common';

/** The metadata key `SessionAuthGuard` reads via `Reflector`. */
export const BLOCKED_SESSION_READ_ONLY_METADATA = 'blockedSessionReadOnly';

/**
 * Marks a non-`GET` route as read-only, so `SessionAuthGuard` lets a blocked
 * person's session through it as it does a `GET`.
 *
 * For a route that is a `POST` only because its question does not fit a query
 * string, and that writes nothing and hands out nothing spendable. Every use
 * is an explicit, reviewed exception — today
 * `POST /providers/me/slash-requests/lookup`, which a blocked provider needs
 * most (it matches pending on-chain penalties to their Assay cases), and
 * `POST /providers/me/slash-requests/dispute-intent`, which only builds an
 * unsigned call for the provider's own key. The
 * dashboard's client-side write guard allows the same routes
 * (`READ_ONLY_POSTS` in `assay-frontend`'s `account-block/state.ts`).
 *
 * A machine credential of a blocked account is still refused outright: that
 * happens in `BlocklistSessionSource`, before this guard sees a session.
 */
export const BlockedSessionReadOnly = () => SetMetadata(BLOCKED_SESSION_READ_ONLY_METADATA, true);

/** The metadata key for {@link AllowedWhileBlocked}. */
export const ALLOWED_WHILE_BLOCKED_METADATA = 'allowedWhileBlocked';

/**
 * Marks a WRITE route a blocked person must still be able to use, so
 * `SessionAuthGuard` lets their session through it.
 *
 * Kept apart from {@link BlockedSessionReadOnly} so "read-only" stays true:
 * these routes write, but only to take authority AWAY from the account —
 * revoking an escrow delegate (`POST /escrow/delegates/revoke-intent` and
 * `/revoke`) and revoking an agent credential
 * (`DELETE /agents/:agentId/credentials/:id`). Owner requirement 6: a blocked
 * account can still revoke its delegates, and the contract allows it; without
 * this a leaked delegate or credential would come back to life on unblock
 * (audit E-5). Every use is an explicit, reviewed exception, mirrored in the
 * dashboard's `READ_ONLY_POSTS`.
 */
export const AllowedWhileBlocked = () => SetMetadata(ALLOWED_WHILE_BLOCKED_METADATA, true);
