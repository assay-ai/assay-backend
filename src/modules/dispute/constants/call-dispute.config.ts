/**
 * The dials of buyer call disputes (G3.B1). Read from the environment once,
 * at boot; a malformed value falls back to its default, as `loadSlashConfig`
 * does, so a typo cannot stop the API from booting.
 */
export interface CallDisputeConfig {
  /** How long after a call settled its buyer may still dispute it. */
  readonly filingWindowMs: number;
  /** Disputes one buyer organization may file per rolling 24 hours. */
  readonly maxFilingsPerDay: number;
  /**
   * The tighter limit for a buyer whose disputes are mostly rejected: at least
   * `abuseRejectedThreshold` rejected in the last 30 days, and more rejected
   * than upheld.
   */
  readonly abuseMaxFilingsPerDay: number;
  readonly abuseRejectedThreshold: number;
  /**
   * An upheld decision owing at least this much (minor units of the call's
   * asset) needs a second operator. Below it one operator decides.
   */
  readonly twoPersonThresholdMinor: string;
  /** The largest evidence snapshot kept, in bytes of JSON; larger bodies are cut. */
  readonly snapshotMaxBytes: number;
  /**
   * How long after a dispute is decided (or withdrawn) its snapshot keeps the
   * call's request and response. After it they are deleted; the call's facts
   * and the verdict stay, so the decision can still be read.
   */
  readonly snapshotRetentionMs: number;
}

export const CALL_DISPUTE_CONFIG = Symbol('CALL_DISPUTE_CONFIG');

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_CALL_DISPUTE_CONFIG: CallDisputeConfig = Object.freeze({
  filingWindowMs: 7 * DAY_MS,
  maxFilingsPerDay: 20,
  abuseMaxFilingsPerDay: 2,
  abuseRejectedThreshold: 5,
  twoPersonThresholdMinor: '5000000',
  snapshotMaxBytes: 64 * 1024,
  snapshotRetentionMs: 30 * DAY_MS,
});

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readMinor(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^\d+$/.test(raw) ? raw : fallback;
}

export function loadCallDisputeConfig(env: NodeJS.ProcessEnv = process.env): CallDisputeConfig {
  const defaults = DEFAULT_CALL_DISPUTE_CONFIG;
  return {
    filingWindowMs:
      readInt(env, 'CALL_DISPUTE_FILING_WINDOW_DAYS', defaults.filingWindowMs / DAY_MS) * DAY_MS,
    maxFilingsPerDay: readInt(env, 'CALL_DISPUTE_MAX_PER_DAY', defaults.maxFilingsPerDay),
    abuseMaxFilingsPerDay: readInt(
      env,
      'CALL_DISPUTE_ABUSE_MAX_PER_DAY',
      defaults.abuseMaxFilingsPerDay,
    ),
    abuseRejectedThreshold: readInt(
      env,
      'CALL_DISPUTE_ABUSE_REJECTED_THRESHOLD',
      defaults.abuseRejectedThreshold,
    ),
    twoPersonThresholdMinor: readMinor(
      env,
      'CALL_DISPUTE_TWO_PERSON_THRESHOLD_MINOR',
      defaults.twoPersonThresholdMinor,
    ),
    snapshotMaxBytes: readInt(env, 'CALL_DISPUTE_SNAPSHOT_MAX_BYTES', defaults.snapshotMaxBytes),
    snapshotRetentionMs:
      readInt(env, 'CALL_DISPUTE_SNAPSHOT_RETENTION_DAYS', defaults.snapshotRetentionMs / DAY_MS) *
      DAY_MS,
  };
}
