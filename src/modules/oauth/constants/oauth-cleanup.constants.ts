/**
 * The OAuth cleanup job's schedule and retention windows (spec §6.2).
 * Credential rows have no retention here: they are never deleted.
 */

/** Daily at 03:17 UTC (seconds field first, as in the other jobs). */
export const OAUTH_CLEANUP_CRON = '0 17 3 * * *';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Access tokens are deleted this long after `expires_at`: as long as refresh
 * tokens, so the stale-reuse check (§6.3.11) still sees a chain's
 * `first_used_at` while a used refresh token can be presented.
 */
export const OAUTH_CLEANUP_ACCESS_TOKEN_RETENTION_MS = 30 * DAY_MS;

/** Refresh tokens, in any state, are deleted this long after `expires_at`. */
export const OAUTH_CLEANUP_REFRESH_TOKEN_RETENTION_MS = 30 * DAY_MS;

/** Authorization codes are deleted this long after `expires_at`. */
export const OAUTH_CLEANUP_CODE_RETENTION_MS = 1 * DAY_MS;

/** A DCR or CIMD client must be at least this old, and unused and unfetched this long, to be deleted. */
export const OAUTH_CLEANUP_CLIENT_MIN_AGE_MS = 30 * DAY_MS;

/**
 * One run per window across every scheduler replica: `SET … NX EX`. The lock
 * is not released at the end of a run, so it also stops a second run inside
 * the hour.
 */
export const OAUTH_CLEANUP_LOCK_KEY = 'oauth:cleanup:lock';
export const OAUTH_CLEANUP_LOCK_TTL_SECONDS = 3600;

/**
 * Rows per token or code delete statement, so no statement holds locks for
 * long; also the most clients one run deletes.
 */
export const OAUTH_CLEANUP_BATCH_SIZE = 5000;

/** DI token for `OAuthCleanupConfig`. */
export const OAUTH_CLEANUP_CONFIG = 'OAUTH_CLEANUP_CONFIG';
