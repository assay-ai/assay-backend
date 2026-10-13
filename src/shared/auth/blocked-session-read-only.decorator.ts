import { SetMetadata } from '@nestjs/common';

/** The metadata key `SessionAuthGuard` reads via `Reflector`. */
export const BLOCKED_SESSION_READ_ONLY_METADATA = 'blockedSessionReadOnly';

/**
 * Marks a non-`GET` route as read-only, so `SessionAuthGuard` lets a blocked
 * person's session through it as it does a `GET`.
 *
 * For a route that is a `POST` only because its question does not fit a query
 * string, and that writes nothing and hands out nothing spendable. Every use
 * is an explicit, reviewed exception — today only
 * `POST /providers/me/slash-requests/lookup`, which a blocked provider needs
 * most: it matches pending on-chain penalties to their Assay cases. The
 * dashboard's client-side write guard allows the same routes
 * (`READ_ONLY_POSTS` in `assay-frontend`'s `account-block/state.ts`).
 *
 * A machine credential of a blocked account is still refused outright: that
 * happens in `BlocklistSessionSource`, before this guard sees a session.
 */
export const BlockedSessionReadOnly = () => SetMetadata(BLOCKED_SESSION_READ_ONLY_METADATA, true);
