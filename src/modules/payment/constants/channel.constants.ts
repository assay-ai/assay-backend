import {
  channelBootRefusal,
  ChannelPolicy,
  DEFAULT_CHANNEL_POLICY,
} from '../domain/channel/channel-policy';

/**
 * The channel door's flag and policy, read from the environment (SPEC-W2,
 * API-W2 §6). **Off by default:** with `EVM_CHANNELS_LIVE_CHAINS` empty no
 * channel is offered and a channel voucher is refused (`CHANNEL_NOT_OFFERED`).
 * The flag gates NEW admission only (review 2026-10-31 L7): channels that
 * already exist keep being settled, collected and refunded with it off, so
 * clearing it never strands their money. The reconciler is channel-aware
 * whatever the flag says (SPEC-W2 §1.2: it must be proven before the first
 * settle).
 */

/** Why a channel call was closed by the terminal timeout (`status_reason`). */
export const CHANNEL_TERMINAL_TIMEOUT_REASON = 'channel_terminal_timeout';
/** …and why a SERVED one was settled at it, as served and unverified (owner decision). */
export const CHANNEL_TERMINAL_UNVERIFIED_REASON = 'channel_terminal_timeout_unverified';

/** Injection tokens. */
export const CHANNEL_POLICY = 'CHANNEL_POLICY';
export const CHANNEL_LIVE_CHAINS = 'CHANNEL_LIVE_CHAINS';
export const CHANNEL_REQUIRED_CHAINS = 'CHANNEL_REQUIRED_CHAINS';

export const EVM_CHANNELS_LIVE_CHAINS_ENV = 'EVM_CHANNELS_LIVE_CHAINS';
/**
 * The chains where a paid call MUST be paid through the channel door (owner
 * decision 2026-11-04): a client that does not offer `channel-v1` in
 * `_meta["assay/paymentSchemes"]` is refused with `PAYMENT_CHANNEL_REQUIRED`
 * before anything is allocated or signed, so old clients are told to upgrade
 * instead of paying one on-chain redeem per call. Only chains that are also in
 * `EVM_CHANNELS_LIVE_CHAINS` are enforced. A client that offers `channel-v1`
 * keeps the per-call fallback the channel protocol itself defines (no channel
 * offered, lane cap, signer expiring), and so does a payer that used a lane
 * recently ({@link CHANNEL_REQUIRED_RECENT_LANE_DAYS}).
 */
export const EVM_CHANNELS_REQUIRED_CHAINS_ENV = 'EVM_CHANNELS_REQUIRED_CHAINS';
/**
 * A payer whose lane was touched within this many days may still pay per call
 * without offering `channel-v1`: SDK/MCP 1.2.0 stop offering it for an hour
 * after `CHANNEL_LIMIT`, `CHANNEL_SIGNER_EXPIRING` or `CHANNEL_NOT_OFFERED`,
 * and a second process on the same key never offers it. A client that never
 * opened a lane (anything older than 1.2.0) is refused.
 */
export const CHANNEL_REQUIRED_RECENT_LANE_DAYS = 7;

/** The MCP `_meta` keys of the channel door (API-W2 §1). */
export const ASSAY_PAYMENT_SCHEMES = 'assay/paymentSchemes';
export const ASSAY_CHANNEL_VOUCHER = 'assay/channelVoucher';
export const ASSAY_CHANNEL_REQUIRED = 'assay/channelRequired';
export const CHANNEL_SCHEME = 'channel-v1';

/**
 * Two rows never differ by more than this per row in their fee split
 * (`floor(price · r / 1e4)` per row against one floor per bucket): the
 * reconciler's tolerance for grouped collects (SPEC-W2 §2).
 */
export const CHANNEL_FEE_DUST_PER_ROW_ATOMIC = 1n;

/** The channels a payer may keep at most at mainnet launch (v3 §9.3). */
export const CHANNEL_MAINNET_MAX_OPEN_PER_PAYER = 4;
/** The mainnet chain the launch cap applies to. */
export const CHANNEL_MAINNET_CHAIN_ID = 'eip155:4663';

/**
 * The open-channel cap on `chainId`: the configured one, but never above
 * {@link CHANNEL_MAINNET_MAX_OPEN_PER_PAYER} on mainnet, whatever
 * `CHANNEL_MAX_OPEN_PER_PAYER` says (review 2026-10-31 L2).
 */
export function maxOpenChannelsOn(chainId: string, configured: number): number {
  return chainId === CHANNEL_MAINNET_CHAIN_ID
    ? Math.min(configured, CHANNEL_MAINNET_MAX_OPEN_PER_PAYER)
    : configured;
}

export function parseChannelLiveChains(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.startsWith('eip155:')),
  );
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got "${raw}"`);
  }
  return Number(raw);
}

function atomic(env: NodeJS.ProcessEnv, name: string, fallback: bigint, min: bigint): bigint {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,18}$/.test(raw) || BigInt(raw) < min) {
    throw new Error(`${name} must be an integer of at least ${min}, got "${raw}"`);
  }
  return BigInt(raw);
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return true;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false", got "${raw}"`);
}

/**
 * The policy, validated, with the boot check applied (SPEC-W2 §6): a malformed
 * value, or a slow cadence without every safety on, refuses to boot.
 */
export function loadChannelPolicy(env: NodeJS.ProcessEnv = process.env): ChannelPolicy {
  const d = DEFAULT_CHANNEL_POLICY;
  const policy: ChannelPolicy = {
    tAgeSeconds: integer(env, 'CHANNEL_T_AGE_SECONDS', d.tAgeSeconds, 60, 3_300),
    hardCapSeconds: d.hardCapSeconds,
    deadlineMarginSeconds: integer(
      env,
      'CHANNEL_DEADLINE_MARGIN_SECONDS',
      d.deadlineMarginSeconds,
      3_600,
      5_400,
    ),
    landingMarginSeconds: d.landingMarginSeconds,
    tickSeconds: d.tickSeconds,
    aCapAtomic: atomic(env, 'CHANNEL_A_CAP_ATOMIC', d.aCapAtomic, 1n),
    maxOpenPerPayer: integer(env, 'CHANNEL_MAX_OPEN_PER_PAYER', d.maxOpenPerPayer, 1, 16),
    terminalTimeoutSeconds: d.terminalTimeoutSeconds,
    collectIntervalSeconds: integer(
      env,
      'CHANNEL_COLLECT_INTERVAL_SECONDS',
      d.collectIntervalSeconds,
      3_600,
      21_600,
    ),
    urgentReservationBps: d.urgentReservationBps,
    urgentIntervalSeconds: integer(
      env,
      'CHANNEL_URGENT_INTERVAL_SECONDS',
      d.urgentIntervalSeconds,
      60,
      3_600,
    ),
    hourlyPayoutMinimumAtomic: atomic(
      env,
      'PROVIDER_PAYOUT_HOURLY_MIN_ATOMIC',
      d.hourlyPayoutMinimumAtomic,
      1n,
    ),
    switches: {
      deadlineTrigger: flag(env, 'CHANNEL_DEADLINE_TRIGGER'),
      collectFirst: flag(env, 'CHANNEL_COLLECT_FIRST'),
      globalReservation: flag(env, 'CHANNEL_GLOBAL_RESERVATION'),
      perChannelAlerts: flag(env, 'CHANNEL_ALERTS'),
      floatReserveMonitor: flag(env, 'REDEEMER_FLOAT_RESERVE_MONITOR'),
    },
  };
  const refusal = channelBootRefusal(policy);
  if (refusal) throw new Error(`Channel boot check: ${refusal}`);
  const terminal = terminalTimeoutRefusal(policy.terminalTimeoutSeconds, env);
  if (terminal) throw new Error(`Channel boot check: ${terminal}`);
  return policy;
}

/**
 * What a channel call may take between its admission and the provider's
 * answer, beyond the router's own deadline: securing the hold, the spend
 * lock, mapping and the schema check, the DB writes, and one scheduler tick
 * of lateness. `T_term` must exceed the router deadline by more than this
 * (sec-audit 2026-11-01 B-S1), so a call still executing is never voided.
 * Semantic verification runs after `VERIFYING`, which `T_term` settles as
 * served (owner decision), so it does not shorten this.
 */
export const TERMINAL_TIMEOUT_MARGIN_SECONDS = 120;
/** The router's whole-request deadline env (`ToolModule`), default 30 s. */
const ROUTER_TOTAL_DEADLINE_ENV = 'ROUTER_TOTAL_DEADLINE_MS';
const ROUTER_TOTAL_DEADLINE_DEFAULT_MS = 30_000;

/**
 * Why `T_term` is too short for the configured provider-call deadline, or
 * `null`. The router aborts a provider call at `ROUTER_TOTAL_DEADLINE_MS`
 * (every attempt's budget is capped by it, and a binding's own `timeout_ms`
 * by it too), so `PROVIDER_EXECUTING` cannot last longer than that.
 */
export function terminalTimeoutRefusal(
  terminalTimeoutSeconds: number,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[ROUTER_TOTAL_DEADLINE_ENV];
  const deadlineMs =
    raw === undefined || raw === '' ? ROUTER_TOTAL_DEADLINE_DEFAULT_MS : Number(raw);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return null; // the router's own parse decides
  const needed = deadlineMs / 1000 + TERMINAL_TIMEOUT_MARGIN_SECONDS;
  if (terminalTimeoutSeconds > needed) return null;
  return (
    `the channel terminal timeout (${terminalTimeoutSeconds} s) must exceed ` +
    `${ROUTER_TOTAL_DEADLINE_ENV} (${deadlineMs} ms) plus ${TERMINAL_TIMEOUT_MARGIN_SECONDS} s, ` +
    `or a provider call still running is voided`
  );
}

let fromEnv: ChannelPolicy | null = null;
/**
 * The deployment's channel policy read from the environment, for a reader
 * outside `PaymentModule` that cannot inject `CHANNEL_POLICY` (e2e B-2: a
 * display bound must use the configured cadence, not the defaults). The boot
 * check already refused a bad value; here one falls back to the defaults.
 */
export function channelPolicyFromEnv(): ChannelPolicy {
  if (fromEnv === null) {
    try {
      fromEnv = loadChannelPolicy(process.env);
    } catch {
      fromEnv = DEFAULT_CHANNEL_POLICY;
    }
  }
  return fromEnv;
}

/**
 * The upper bound, in seconds after its admission, by which a pending call is
 * settled on chain: the longer of the per-call door's `REDEEM_MAX_WAIT_SECONDS`
 * and the channel door's `CHANNEL_T_AGE_SECONDS` (both as configured).
 */
export function settleBoundSeconds(tAgeSeconds: number, redeemMaxWaitSeconds: number): number {
  return Math.max(tAgeSeconds, redeemMaxWaitSeconds);
}
