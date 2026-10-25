/**
 * The credential-expiry sweep's numbers and vocabulary.
 *
 * `AgentCredentialEntity.expiresAt` (`agent_credentials`) was long unread
 * against the clock — this is the first sweeper. **This is the machine
 * credential a `POST /agents/:agentId/credentials` call issues, not a Privy
 * session signer.** A Privy session signer does not exist yet in this
 * codebase; naming this a "session" anywhere in code or copy would claim a
 * feature that is not built. See `CredentialExpirySweepService`'s own class comment.
 */

/** Every 6 hours — day-granularity warnings do not need minute precision. */
export const CREDENTIAL_EXPIRY_SWEEP_CRON = '0 0 */6 * * *';

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `session.expiring` fires exactly twice: T−7d and T−1d. Expressed as the two edges of the two warning
 * windows a candidate can fall into; `CredentialExpirySweepService` computes
 * which window (if any) a credential's `msUntilExpiry` lands in and lets
 * `NotificationAggregation.ONCE`, keyed on `` `${credentialId}:T-7` `` /
 * `` `${credentialId}:T-1` ``, collapse a sweep that finds the same credential
 * in the same window on consecutive passes into exactly one delivery.
 */
export const CREDENTIAL_EXPIRY_WARNING_T7_MS = 7 * ONE_DAY_MS;
export const CREDENTIAL_EXPIRY_WARNING_T1_MS = 1 * ONE_DAY_MS;

/** DI token for {@link CredentialExpirySweepConfig}. */
export const CREDENTIAL_EXPIRY_SWEEP_CONFIG = 'CREDENTIAL_EXPIRY_SWEEP_CONFIG';

/** `now` as a function, kill-switch style, so a test can move the clock without waiting days. */
export interface CredentialExpirySweepConfig {
  readonly now: () => number;
}

/**
 * The most live (not revoked, not expired) API-key credentials one agent may
 * hold at once. A guardrail against a runaway or accidental key-creation loop
 * and unbounded growth — not a product tier. Sized for generous legitimate use
 * (rotation overlap + several environments + a per-host fleet, ~20) with
 * headroom; raise it here if a fleet needs more. The OAuth sibling cap is 50
 * (OAUTH_MAX_LIVE_GRANTS_PER_AGENT); API keys are tighter because they are
 * created by hand rather than minted by an authorize flow.
 */
export const MAX_ACTIVE_API_KEYS_PER_AGENT = 25;

/** A new API key's lifetime when `POST /agents/:agentId/credentials` names none. */
export const CREDENTIAL_DEFAULT_LIFETIME_DAYS = 90;

/** The longest lifetime a new API key may have. There is no "never". */
export const CREDENTIAL_MAX_LIFETIME_DAYS = 365;
