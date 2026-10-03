/**
 * The documented defaults every new agent and
 * every service credential ships with, and the platform-owned numbers the
 * duplicate-request detector and the alert bands run on.
 *
 * These are not "sensible defaults chosen at implementation time" — the
 * product's acceptance criterion names the four money defaults and the two
 * velocity defaults verbatim: *"`perCallLimit $0.50`, `dailyLimit $10`, `monthlyLimit
 * $100`, `requireApprovalAbove $2.00`, velocity `60 calls/min` and
 * `$5/hour`."* Anything below that is not a direct transcription of that
 * sentence is called out as this file's own decision.
 */

/**
 * The five money defaults, in **US cents** — not atomic units, because atomic
 * units depend on an asset's `decimals` and a default must be denominated in
 * whatever asset a policy is first written against (see
 * {@link centsToAtomicUnits}). Cents are the smallest unit the default numbers
 * are all whole in ($0.50, $10, $100, $2.00, $5), so nothing here rounds.
 */
export const SPEND_POLICY_DOLLAR_DEFAULTS = Object.freeze({
  /** `perCallLimit $0.50`. */
  perCallMaxCents: 50,
  /** `dailyLimit $10`. */
  dailyCapCents: 1_000,
  /** `monthlyLimit $100`. */
  monthlyCapCents: 10_000,
  /** `requireApprovalAbove $2.00`. */
  requireApprovalAboveCents: 200,
  /** Velocity `$5/hour`. */
  maxSpendPerHourCents: 500,
});

/**
 * The two count-based velocity defaults.
 *
 * `maxCallsPerHour` is deliberately **not** defaulted here. The criterion names
 * exactly two velocity numbers — `60 calls/min` and `$5/hour` — and says
 * nothing about an hourly *call* ceiling, which is the older, separate
 * `max_calls_per_hour` column. Inventing a number for it (even a derived one
 * like `60 × 60`) would put a figure in front of users that no product document
 * chose, so a freshly seeded organization default leaves it `NULL` —
 * "unlimited" — exactly like every other unset ceiling on this table. An
 * operator who wants one sets it through `PATCH /spend-policy`.
 */
export const SPEND_POLICY_VELOCITY_DEFAULTS = Object.freeze({
  /** Velocity `60 calls/min`. */
  maxCallsPerMinute: 60,
});

/**
 * The duplicate-request detector's own numbers: *"a duplicate-call detector
 * fires on ≥N identical request hashes in a window."* Neither `N` nor the
 * window is specified anywhere else, so both are this file's
 * decision, made once and documented rather than buried as a literal at the
 * call site.
 *
 * `THRESHOLD = 5` is chosen to sit above the handful of legitimate identical
 * retries an agent's own HTTP client performs (1–2, on a timeout) and well
 * below what a genuine runaway loop produces in the same window — the
 * acceptance check retries **100 times inside one minute**, which trips this at
 * the 5th attempt with 95 to spare.
 *
 * `WINDOW_MS` matches {@link SPEND_POLICY_VELOCITY_DEFAULTS}'s
 * `maxCallsPerMinute` window on purpose: one mental model ("this minute") for
 * every velocity number on this screen, rather than a second window length
 * nobody can eyeball against the first.
 */
export const DUPLICATE_REQUEST_THRESHOLD = 5;
export const DUPLICATE_REQUEST_WINDOW_MS = 60_000;

/**
 * Alert bands at 50/80/100% of the daily and monthly caps. Ordered
 * ascending so "the highest band this call newly crossed" is a linear scan.
 */
export const SPEND_ALERT_BANDS: readonly number[] = Object.freeze([50, 80, 100]);

/**
 * `cents` (whole US cents, no fractional cent in this catalogue) converted to
 * atomic units of an asset with `decimals` places, floored — the same
 * rounding direction `MoneyUtil` uses everywhere else, so a default never
 * favours the platform over the agent by a fraction of a cent.
 *
 * BigInt throughout: `decimals` can be 0 (whole-unit assets) or as high as 18
 * (most EVM tokens), and `cents * 10^decimals / 100` overflows a JS `number`
 * for realistic values well before it overflows a `bigint`.
 */
export function centsToAtomicUnits(cents: number, decimals: number): string {
  const scaled = BigInt(cents) * 10n ** BigInt(decimals);
  return (scaled / 100n).toString();
}
