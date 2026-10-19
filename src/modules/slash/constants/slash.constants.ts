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
   * 72 hours: the platform's own floor under the on-chain record's
   * `executableAt`, stated to the provider as "nothing is taken before".
   */
  readonly timelockMs: number;

  /**
   * The de-minimis floor, in minor units. **Ships at `0`, meaning disabled.**
   *
   * A floor is mandatory, and roughly $25 is the marginal cost of adjudicating
   * one case. But a typical case is a $5 case,
   * which a $25 floor would erase, so the mechanism ships and the number does
   * not. Setting it is a config change and a product decision, not a migration.
   */
  readonly deMinimisMinor: string;

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
  return {
    timelockMs: readInt('SLASH_TIMELOCK_HOURS', 72) * HOUR_MS,
    deMinimisMinor: readMinor('SLASH_DE_MINIMIS_MINOR', '0'),
    sweepBatchSize: readInt('SLASH_SWEEP_BATCH_SIZE', 100),
    assetDecimals: readInt('SLASH_ASSET_DECIMALS', 6),
  };
}

/** DI token: {@link ProRataSlashConfig}. */
export const SLASH_PRORATA_CONFIG = 'SLASH_PRORATA_CONFIG';

/**
 * The dials of the per-agent, on-chain split.
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

/**
 * `DISPUTE_TIMEOUT_SECONDS` (assay-evm `Constants.sol:56`, D-19), mirrored: a
 * `Disputed` record is `expireSlash`-able at `disputedAt + 30 d`
 * (`DisputeUnresolved`) — the seven-day execution grace does not apply to it.
 */
export const DISPUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Review R2-2: how long past a record's `executableAt` the platform waits
 * before it treats the record as undisputed. A `disputeSlash` sent just
 * before the door is mirrored only once the watcher reads it (every two
 * minutes, `EVM_CHAIN_STATE_CONFIRMATIONS` behind the head), so a case is
 * labelled `UPHELD` / `AUTO_UNDISPUTED` only after this margin. Labels only:
 * the chain itself refuses to execute a disputed record (`SlashNotPending`).
 */
export const CHAIN_DISPUTE_SETTLE_MS = 10 * 60 * 1000;
