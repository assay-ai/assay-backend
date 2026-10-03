/**
 * The stake monitor's numbers and its one vocabulary.
 *
 * One job runs off this tick: opening and resolving grace rows. There used to
 * be a second, asserting each provider's unsettled exposure on chain, and the
 * simplified contract removed the instruction it called.
 */

/**
 * Every five minutes.
 *
 * This is the maximum delay between a provider dropping below their floor and
 * the row existing. Until the row exists the router cuts them —
 * `applyStakeGrace` correctly returns `STAKE_BELOW_MINIMUM` rather than
 * "expired" when there is no row, but the binding is still not routable. So
 * this number is how long the grace promise ("your traffic is still flowing") is
 * untrue for.
 */
export const STAKE_MONITOR_CRON = '0 */5 * * * *';

/**
 * The 7-day grace window.
 *
 * Written onto the row as `expires_at` at the moment it opens, never
 * re-derived: changing this constant later must not retroactively shorten a
 * period a provider is already counting down. That is why the column exists at
 * all rather than the job comparing `started_at + 7 days` on every pass.
 */
export const STAKE_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How little headroom counts as "about to hit the floor" — 20%.
 *
 * *Warn when approaching the floor* is its own signal, separate from the grace
 * period, and the separation is the point:
 * a provider whose first notification is "you are below the minimum" has
 * already lost the chance to act cheaply. The Capital screen renders the same threshold as
 * `Headroom $0.00 ⚠ no buffer`.
 *
 * Measured against the **requirement**, not against the stake, so the warning
 * means the same thing to a provider with one $50 binding and to one with ten.
 */
export const STAKE_HEADROOM_WARNING_RATIO = 0.2;

/**
 * How a grace period ended — the `resolution` column's vocabulary, finally as a
 * TypeScript enum.
 *
 * The values are fixed by `provider_stake_grace`'s CHECK constraint, which is
 * the authority; this is the branch the writer takes, which is what
 * `provider-stake-grace.entity.ts` said would place it ("a TypeScript enum
 * belongs with the service that first has to branch on them"). It lives here
 * rather than on the service so that the reader — the Capital screen's grace history — can
 * import the vocabulary without importing the scheduler's dependency graph.
 *
 * **Recorded, never inferred.** Deriving it from `resolved_at` against
 * `expires_at` fails at the boundary in both directions, and the boundary is
 * where every interesting case sits: this job runs on a 5-minute tick, so a
 * top-up noticed 30 seconds after the deadline would read as an expiry, and a
 * late sweep would write an expiry indistinguishable from a very late cure.
 * The writer knows which happened; nothing ever knows again.
 */
export enum StakeGraceResolution {
  /** The provider topped back up above the floor before the deadline. */
  CURED = 'CURED',
  /** The deadline passed with the shortfall still in place. */
  EXPIRED = 'EXPIRED',
}

/** DI token for the monitor's {@link StakeMonitorConfig}. */
export const STAKE_MONITOR_CONFIG = 'STAKE_MONITOR_CONFIG';

/**
 * The monitor's tunables, injected rather than read from the wall clock.
 *
 * `now` is a function for the reason `ONCHAIN_PROVIDER_STAKE_CONFIG`'s is: a
 * test has to be able to stand a grace period one second past its deadline
 * without waiting seven days for it.
 */
export interface StakeMonitorConfig {
  readonly gracePeriodMs: number;
  readonly headroomWarningRatio: number;
  readonly now: () => number;
}
