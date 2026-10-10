/**
 * The numbers the slash lifecycle runs on.
 *
 * Every one is config rather than a constant, for the reason the
 * economic-parameters panel gives: *"a parameter that can move silently is a
 * parameter nobody can price."* A value baked into a service moves on a deploy
 * and is visible only in a diff; one read from config moves on a restart and
 * can be stated on a screen.
 */
export const SLASH_CONFIG = 'SLASH_CONFIG';

export interface SlashConfig {
  /**
   * How long after proposal anything may execute — the timelock.
   *
   * 72 hours, matching `DISPUTE_RESPONSE_WINDOW_HOURS`, and the two are the
   * same number for a reason worth stating: the timelock is what makes an
   * appeal meaningful. The 72-hour dispute timelock did not exist on chain — the
   * program's compensating
   * control is the reversal, which undoes a wrong slash *after* the money moved
   * and costs the platform the agent's 60%. This is the off-chain half, and it
   * is cheaper than the reversal precisely because it stops the money moving at
   * all.
   */
  readonly timelockMs: number;

  /**
   * How long the provider has to object, measured from **delivery**.
   *
   * Shorter than the timelock, so a provider who objects on the last hour still
   * leaves us time to decide before anything executes. Equal windows would mean
   * an objection filed at the deadline arrives with zero time to work it, which
   * under the platform-miss rule overturns it automatically — generous to
   * that provider and useless as a process.
   */
  readonly responseWindowMs: number;

  /**
   * How long **we** have to decide, measured from the objection.
   *
   * Missing it overturns the case against us (the platform-miss rule): this is
   * the only deadline in the lifecycle that costs the platform anything.
   */
  readonly platformDecisionWindowMs: number;

  /**
   * How long before the chain opens the off-chain case must already be closed.
   *
   * `execute_slash` takes *any* signer as `payer` — the program consults it
   * about nothing — so at `executable_at` the judgement becomes executable by
   * anybody, whatever this database says. The two sweepers run on a one-minute
   * cron and a `cancel_slash` is an RPC round trip, so "closed at exactly
   * `executable_at`" is not closed in time. This is the band that makes the
   * ordering real rather than nominal.
   *
   * Its only consumer is `assertClocksFit` below, and that is deliberate: the
   * band is not a delay anything waits out, it is the slack the other three
   * windows must leave. Nothing schedules against it.
   */
  readonly executionGuardMs: number;

  /**
   * The de-minimis floor, in minor units. **Ships at `0`, meaning disabled.**
   *
   * A floor is mandatory, and roughly $25 is the marginal cost of adjudicating
   * one case. But a typical case is a $5 case,
   * which a $25 floor would erase, so the mechanism ships and the number does
   * not. Setting it is a config change and a product decision, not a migration.
   */
  readonly deMinimisMinor: string;

  /**
   * At or above this, a decision needs a second signature.
   *
   * The rule: double review above a materiality threshold, single review with a
   * sampled audit below it. An overturn that opens a fleet sweep is seconded
   * regardless of amount, because its blast radius is the largest any single
   * decision here has.
   */
  readonly secondSignatureThresholdMinor: string;

  /** Rows per sweeper pass. Bounds the work one tick can do. */
  readonly sweepBatchSize: number;

  /** Decimals of the staked asset, for rendering money on this surface. */
  readonly assetDecimals: number;
}

const HOUR_MS = 60 * 60 * 1000;

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  // A malformed value falls back rather than throwing. These are operational
  // dials, and a typo in one of them must not stop the process that adjudicates
  // penalties from booting — the failure mode of "we could not decide anybody's
  // case for six hours" is worse than the failure mode of "the window was the
  // default".
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readMinor(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^\d+$/.test(raw) ? raw : fallback;
}

export function loadSlashConfig(): SlashConfig {
  const config: SlashConfig = {
    timelockMs: readInt('SLASH_TIMELOCK_HOURS', 72) * HOUR_MS,
    responseWindowMs: readInt('SLASH_RESPONSE_WINDOW_HOURS', 48) * HOUR_MS,
    // 23, not 24. See `executionGuardMs`: 48 + 24 is exactly 72,
    // and a process that has to cancel on chain before the chain opens cannot
    // work with zero slack. The hour is taken from the platform's own deadline
    // because every other deadline is on the provider and this one is on us.
    platformDecisionWindowMs: readInt('SLASH_PLATFORM_DECISION_WINDOW_HOURS', 23) * HOUR_MS,
    executionGuardMs: readInt('SLASH_EXECUTION_GUARD_HOURS', 1) * HOUR_MS,
    deMinimisMinor: readMinor('SLASH_DE_MINIMIS_MINOR', '0'),
    secondSignatureThresholdMinor: readMinor('SLASH_SECOND_SIGNATURE_THRESHOLD_MINOR', '2500000'),
    sweepBatchSize: readInt('SLASH_SWEEP_BATCH_SIZE', 100),
    assetDecimals: readInt('SLASH_ASSET_DECIMALS', 6),
  };

  assertClocksFit(config);
  return config;
}

/**
 * The one dial combination this file refuses to fall back on.
 *
 * Every other malformed value here falls back to its default, because a typo in
 * an operational dial must not stop the process that adjudicates penalties from
 * booting. This one is different in kind: it is not a typo, it is a
 * *combination* that silently re-opens the window in which a third party can
 * execute a judgement whose dispute is still open. A wrong number here costs a
 * provider their stake, so it fails loudly at boot, where somebody is looking.
 */
function assertClocksFit(config: SlashConfig): void {
  const needed =
    config.responseWindowMs + config.platformDecisionWindowMs + config.executionGuardMs;
  if (needed <= config.timelockMs) return;

  const hours = (ms: number): string => (ms / HOUR_MS).toString();
  throw new Error(
    'slash clocks do not fit: SLASH_RESPONSE_WINDOW_HOURS + ' +
      'SLASH_PLATFORM_DECISION_WINDOW_HOURS + SLASH_EXECUTION_GUARD_HOURS must be at most ' +
      `SLASH_TIMELOCK_HOURS. Got ${hours(config.responseWindowMs)} + ` +
      `${hours(config.platformDecisionWindowMs)} + ${hours(config.executionGuardMs)} = ` +
      `${hours(needed)} > ${hours(config.timelockMs)} hours ` +
      `(SLASH_RESPONSE_WINDOW_HOURS=${hours(config.responseWindowMs)}, ` +
      `SLASH_PLATFORM_DECISION_WINDOW_HOURS=${hours(config.platformDecisionWindowMs)}, ` +
      `SLASH_EXECUTION_GUARD_HOURS=${hours(config.executionGuardMs)}, ` +
      `SLASH_TIMELOCK_HOURS=${hours(config.timelockMs)}). ` +
      'The on-chain execute_slash accepts any fee payer once executable_at passes, so a ' +
      'dispute that can still be open at that instant is a judgement a stranger can execute. ' +
      'Either shorten a window or raise both SLASH_TIMELOCK_HOURS and the chain-side ' +
      'Config.slash_delay_seconds (floor MIN_SLASH_DELAY_SECONDS = 72h).',
  );
}

/** DI token: {@link ProRataSlashConfig}. */
export const SLASH_PRORATA_CONFIG = 'SLASH_PRORATA_CONFIG';

/**
 * The two dials of the per-agent, on-chain split. Separate from
 * {@link SlashConfig} so the clocks' fit check stays about clocks.
 */
export interface ProRataSlashConfig {
  /**
   * `SLASH_PRORATA_DUST_REPORT_MINOR` (default `0` = off). A part whose 60%
   * would be below this is kept and REPORTED (logged) — never dropped or
   * redistributed by this setting. (A part the contract can never split at
   * all, below 2 units at 60/30, is always left out and its share re-split
   * among the other agents; see `planProRataSlash`.)
   */
  readonly dustReportBelowMinor: bigint;
  /**
   * `SLASH_PRORATA_STRAGGLER_MAX_ATTEMPTS` (default 6 — one hour of stale-claim
   * retries). A part that still cannot be proposed after this many attempts,
   * while its siblings stand on chain, is given up on (REFUSED, with the
   * reason) so the case can proceed instead of waiting for ever.
   */
  readonly stragglerMaxAttempts: number;
  /**
   * `SLASH_PRORATA_STRAGGLER_DEADLINE_HOURS` (default 24). A straggler is also
   * given up on once its siblings' earliest door is this close.
   */
  readonly stragglerDeadlineMs: number;
}

export function loadProRataSlashConfig(): ProRataSlashConfig {
  return {
    dustReportBelowMinor: BigInt(readMinor('SLASH_PRORATA_DUST_REPORT_MINOR', '0')),
    stragglerMaxAttempts: readInt('SLASH_PRORATA_STRAGGLER_MAX_ATTEMPTS', 6),
    stragglerDeadlineMs: readInt('SLASH_PRORATA_STRAGGLER_DEADLINE_HOURS', 24) * HOUR_MS,
  };
}
