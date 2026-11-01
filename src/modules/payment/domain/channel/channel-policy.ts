import { CHANNEL_GRID_SECONDS, CHANNEL_MAX_BUCKET, ChannelSlot } from './channel-voucher';

/**
 * The channel door's scheduling rules (spec P2 v3.1 §5.3–§5.4, POLICY §2,
 * SPEC-W2 §3–§4, §6, §8). Pure: every input, chain time included, is passed in,
 * so each rule is a unit test.
 *
 * Time is always the CHAIN's (`chainNow`, the latest block's timestamp), never
 * the wall clock: the contract decides expiry, maturity and refund windows on
 * `block.timestamp`, and a scheduler on a different clock would settle a
 * voucher the chain already calls expired.
 */

/** The contract's grace after `expiresAt` (`REDEEM_GRACE_SECONDS`). */
export const CHANNEL_REDEEM_GRACE_SECONDS = 7_200;
/** The contract's anyone-can-collect delay after maturity (`HELD_TIMEOUT_SECONDS`). */
export const CHANNEL_HELD_TIMEOUT_SECONDS = 7 * 24 * 3_600;
/** The contract's `issuedAt` skew (`CLOCK_SKEW_TOLERANCE_SECONDS`); the scheduler keeps to 60. */
export const CHANNEL_SETTLE_FUTURE_ISSUE_SECONDS = 60;

export const PAYOUT_CADENCES = ['HOURLY', 'EVERY_6_HOURS'] as const;
export type PayoutCadence = (typeof PAYOUT_CADENCES)[number];
export const DEFAULT_PAYOUT_CADENCE: PayoutCadence = 'EVERY_6_HOURS';

export interface ChannelPolicy {
  /** Age trigger: the oldest unsettled call this old fires a round (30 min; up to the hard cap). */
  readonly tAgeSeconds: number;
  /** The age trigger's hard cap: a fee spike may postpone it this far, no further (55 min). */
  readonly hardCapSeconds: number;
  /** `U + O`: the deadline trigger fires at `D − (U + O)`; at least 3,600 s (SPEC-W2 §3). */
  readonly deadlineMarginSeconds: number;
  /** `U`: a voucher chosen for a round must still be settleable at `chainNow + U`. */
  readonly landingMarginSeconds: number;
  /** The scheduler tick (admission refuses a delegate after `validUntil − (U + O + tick)`). */
  readonly tickSeconds: number;
  /** Amount trigger and per-channel pending cap (`A_cap`), atomic. */
  readonly aCapAtomic: bigint;
  /** Open channels per payer across all delegates. */
  readonly maxOpenPerPayer: number;
  /** A row not terminal this long after admission is voided (`T_term`). */
  readonly terminalTimeoutSeconds: number;
  /** How often channels are collected on the grid (collect-first runs every grid hour). */
  readonly collectIntervalSeconds: number;
  /** Reservation share of available that starts an urgent round (8,000 = 80%). */
  readonly urgentReservationBps: number;
  /** At most one urgent round per payer (reservation) or asset (debt) per this many seconds. */
  readonly urgentIntervalSeconds: number;
  /** Hourly payout cadence needs at least this much ready, atomic ($25). */
  readonly hourlyPayoutMinimumAtomic: bigint;
  /** Safety switches the boot check requires for a slow cadence (SPEC-W2 §6). */
  readonly switches: ChannelSafetySwitches;
}

export interface ChannelSafetySwitches {
  readonly deadlineTrigger: boolean;
  readonly collectFirst: boolean;
  readonly globalReservation: boolean;
  readonly perChannelAlerts: boolean;
  readonly floatReserveMonitor: boolean;
}

export const DEFAULT_CHANNEL_POLICY: ChannelPolicy = Object.freeze({
  tAgeSeconds: 1_800,
  hardCapSeconds: 3_300,
  deadlineMarginSeconds: 3_600,
  landingMarginSeconds: 1_800,
  tickSeconds: 60,
  aCapAtomic: 5_000_000n,
  maxOpenPerPayer: 16,
  terminalTimeoutSeconds: 300,
  collectIntervalSeconds: 3_600,
  urgentReservationBps: 8_000,
  urgentIntervalSeconds: 300,
  hourlyPayoutMinimumAtomic: 25_000_000n,
  switches: Object.freeze({
    deadlineTrigger: true,
    collectFirst: true,
    globalReservation: true,
    perChannelAlerts: true,
    floatReserveMonitor: true,
  }),
});

/**
 * The boot check (SPEC-W2 §6): a slow channel cadence (`T_age` above 30 min)
 * or a collect interval above an hour is refused unless every safety it relies
 * on is on. Returns the refusal, or `null`.
 */
export function channelBootRefusal(policy: ChannelPolicy): string | null {
  // The reservation is always the one global one across both doors: there is
  // no per-door mode to fall back to, so the switch can only assert it (I1).
  if (!policy.switches.globalReservation) {
    return 'CHANNEL_GLOBAL_RESERVATION=false is not supported: the reservation is always global';
  }
  if (policy.deadlineMarginSeconds < 3_600) {
    return `CHANNEL_DEADLINE_MARGIN_SECONDS must be at least 3600 (got ${policy.deadlineMarginSeconds})`;
  }
  if (policy.tAgeSeconds > policy.hardCapSeconds || policy.hardCapSeconds > 3_300) {
    return `CHANNEL_T_AGE_SECONDS must not exceed the 3300 s hard cap (got ${policy.tAgeSeconds})`;
  }
  const slow = policy.tAgeSeconds > 1_800 || policy.collectIntervalSeconds > 3_600;
  if (!slow) return null;
  const off = Object.entries(policy.switches)
    .filter(([, on]) => !on)
    .map(([name]) => name);
  if (off.length === 0) return null;
  return (
    `channel T_age ${policy.tAgeSeconds} s / collect interval ${policy.collectIntervalSeconds} s ` +
    `needs every safety on; off: ${off.join(', ')}`
  );
}

// ── Deadlines ───────────────────────────────────────────────────────────────

export interface DeadlineInputs {
  /** `expiresAt` (unix s) of the newest voucher that can still be settled. */
  readonly newestUsableExpiresAt: number | null;
  /** The signing delegate's `validUntil` (unix s); `null` for the payer's own key. */
  readonly signerValidUntil: number | null;
  /** End of a revoked delegate's grace (unix s), when revoked. */
  readonly revokeGraceEndsAt: number | null;
  /** End of held caps (`priorCaps.until`), when caps were lowered and held. */
  readonly heldCapsEndAt: number | null;
}

/** `D = min(expiresAt + 7200, validUntil, revoke-grace end, held-caps end)`; `null` when nothing is pending. */
export function channelDeadline(input: DeadlineInputs): number | null {
  const candidates = [
    input.newestUsableExpiresAt === null
      ? null
      : input.newestUsableExpiresAt + CHANNEL_REDEEM_GRACE_SECONDS,
    input.signerValidUntil,
    input.revokeGraceEndsAt,
    input.heldCapsEndAt,
  ].filter((value): value is number => value !== null && value > 0);
  return candidates.length === 0 ? null : Math.min(...candidates);
}

// ── Round triggers ──────────────────────────────────────────────────────────

/** One channel's state as the round builder sees it. */
export interface ChannelPending {
  readonly channelRowId: string;
  readonly payer: string;
  readonly provider: string;
  /** Σ price of served (terminal, charged) rows above `settled_cumulative`. */
  readonly pendingAtomic: bigint;
  /** When the oldest unsettled row was admitted (unix s, chain time of admission). */
  readonly oldestUnsettledAt: number | null;
  readonly deadline: number | null;
  /** A settlement is in flight (`settling_to` set). */
  readonly settling: boolean;
  /** Provider risk: unbonding requested, slash proposed, minimum raised, blocked. */
  readonly providerRisk: boolean;
}

export type RoundTrigger = 'AGE' | 'HARD_CAP' | 'DEADLINE' | 'AMOUNT' | 'PROVIDER_RISK' | 'URGENT';

export interface RoundDecision {
  readonly fire: boolean;
  /** Why, per channel that met a trigger. */
  readonly triggers: ReadonlyMap<string, RoundTrigger>;
  /** At least one channel fired on its deadline (its own budget lane, overrides fee spikes). */
  readonly deadline: boolean;
  /** The round fired only on the age trigger, which a fee spike may postpone. */
  readonly postponable: boolean;
  /** Every channel joining the round (piggyback): pending > 0 and nothing in flight. */
  readonly members: readonly string[];
  /** Latest chain time the next round will fire, when no trigger fires now. */
  readonly nextAt: number | null;
}

/**
 * Whether a round fires now and who joins it (POLICY §2.1–§2.2). A round fires
 * when ANY channel meets a trigger, and then EVERY channel with pending value
 * joins (piggyback: the lever that makes channels cheap). `urgent` names the
 * channels an urgent request covers (a debt replacement, a reservation at 80%).
 * A withdrawal request is not a trigger: its channels join the next round that
 * fires anyway (SPEC-W2 §3).
 */
export function decideRound(
  channels: readonly ChannelPending[],
  chainNow: number,
  policy: ChannelPolicy,
  urgent: ReadonlySet<string> = new Set(),
  feeSpike = false,
): RoundDecision {
  const triggers = new Map<string, RoundTrigger>();
  const members: string[] = [];
  let nextAt: number | null = null;
  const later = (at: number | null) => {
    if (at !== null && (nextAt === null || at < nextAt)) nextAt = at;
  };
  for (const channel of channels) {
    if (channel.settling || channel.pendingAtomic <= 0n) continue;
    members.push(channel.channelRowId);
    const age =
      channel.oldestUnsettledAt === null ? 0 : Math.max(0, chainNow - channel.oldestUnsettledAt);
    const deadlineAt =
      channel.deadline === null || !policy.switches.deadlineTrigger
        ? null
        : channel.deadline - policy.deadlineMarginSeconds;
    // The most urgent reason wins: it picks the budget lane (review 2026-10-31
    // M1). An urgent request (slash, drain, debt) outranks provider risk, and
    // both outrank the amount trigger, so neither is sent on the ordinary lane.
    if (deadlineAt !== null && chainNow >= deadlineAt)
      triggers.set(channel.channelRowId, 'DEADLINE');
    else if (channel.oldestUnsettledAt !== null && age >= policy.hardCapSeconds) {
      triggers.set(channel.channelRowId, 'HARD_CAP');
    } else if (urgent.has(channel.channelRowId)) triggers.set(channel.channelRowId, 'URGENT');
    else if (channel.providerRisk) triggers.set(channel.channelRowId, 'PROVIDER_RISK');
    else if (channel.pendingAtomic >= policy.aCapAtomic) {
      triggers.set(channel.channelRowId, 'AMOUNT');
    } else if (channel.oldestUnsettledAt !== null && age >= policy.tAgeSeconds) {
      triggers.set(channel.channelRowId, 'AGE');
    } else {
      later(
        channel.oldestUnsettledAt === null ? null : channel.oldestUnsettledAt + policy.tAgeSeconds,
      );
      later(deadlineAt);
    }
  }
  const kinds = new Set(triggers.values());
  const postponable = kinds.size > 0 && [...kinds].every((kind) => kind === 'AGE');
  // A gas spike postpones only the age trigger, and only up to the hard cap.
  const fire = triggers.size > 0 && !(postponable && feeSpike);
  return {
    fire,
    triggers,
    deadline: kinds.has('DEADLINE'),
    postponable,
    members: fire ? members : [],
    nextAt: fire ? chainNow : nextAt,
  };
}

/** The budget lane a round trigger is sent on (SPEC-W2 §3, review 2026-10-31 M1). */
export function laneOfTrigger(
  trigger: RoundTrigger | 'PIGGYBACK',
): 'ORDINARY' | 'URGENT' | 'DEADLINE' {
  if (trigger === 'DEADLINE') return 'DEADLINE';
  if (trigger === 'URGENT' || trigger === 'HARD_CAP' || trigger === 'PROVIDER_RISK') {
    return 'URGENT';
  }
  return 'ORDINARY';
}

// ── Lapse classification (review 2026-10-31 H3) ─────────────────────────────

/** Who caused a channel call to lapse unsettled. */
export type LapseCause = 'PROVIDER' | 'BUYER' | 'PLATFORM';

/** Skip reasons the provider caused: its stake, or it is blocked. */
const PROVIDER_LAPSE_REASONS: ReadonlySet<string> = new Set([
  'Stake',
  'Blocked:PROVIDER',
  'PROVIDER_BLOCKED',
]);
/**
 * `NoBucket` while a dispute-kept bucket is still held on the lane (sec-audit
 * 2026-11-01 B-1): the buyer's own dispute keeps a matured bucket, so no new
 * charge can be placed. Recorded instead of `NoBucket` so the lapse is the
 * buyer's (debt). A `NoBucket` with no dispute keep (a rate change) stays the
 * platform's.
 */
export const NO_BUCKET_DISPUTE_KEPT = 'NoBucket:DISPUTE';

/**
 * An `Authority` skip whose only cause is the delegate reaching the
 * `validUntil` admission saw (not revoked, not shortened) after the
 * platform's own settle deadline passed (final review MF-4): the platform's,
 * as the same outage on a payer-signed lane is. Not in the buyer set.
 */
export const AUTHORITY_LAPSED = 'Authority:LAPSED';

/** Skip reasons the buyer caused: its balance, its caps, its key, its dispute keep, or it is blocked. */
const BUYER_LAPSE_REASONS: ReadonlySet<string> = new Set([
  NO_BUCKET_DISPUTE_KEPT,
  'Balance',
  'EscrowWindow',
  'DelegateWindow',
  'PerCallCap',
  'Authority',
  'Blocked:PAYER',
  'PAYER_BLOCKED',
]);

/**
 * Classifies a lapse by the LAST reason its channel's settle did not land
 * (`voucher_channels.last_skip_reason`): the provider's fault → the provider
 * forfeits (buyer hold released, as per call); the buyer's → buyer debt;
 * anything else — an outage, a send that kept failing, `NoBucket` with no
 * dispute keep, `BaseMismatch`, `BadSignature` (admission verified it),
 * `Expired` (the platform did not settle in time), or no reason at all — is
 * the platform's: voided, no debt, nobody paid. A call that was already a
 * buyer debt stays one unless the cause is the provider's (B-2, applied by
 * `ChannelSettlementService.lapseUnsettleable`).
 */
export function classifyLapse(lastSkipReason: string | null): LapseCause {
  if (lastSkipReason === null) return 'PLATFORM';
  if (PROVIDER_LAPSE_REASONS.has(lastSkipReason)) return 'PROVIDER';
  if (BUYER_LAPSE_REASONS.has(lastSkipReason)) return 'BUYER';
  return 'PLATFORM';
}

// ── Voucher choice ──────────────────────────────────────────────────────────

/** A stored voucher of one channel (`channel_vouchers`). */
export interface StoredChannelVoucher {
  readonly id: string;
  readonly cumulative: bigint;
  readonly calls: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** A call on one channel (`payment_intents` of format CHANNEL). */
export interface ChannelCallRow {
  readonly intentId: string;
  readonly cumulative: bigint;
  readonly price: bigint;
  /** Terminal: SETTLED, REFUNDED, VOIDED or EXPIRED. */
  readonly terminal: boolean;
  /** Charged into hold at settle: SETTLED and not upheld before the round. */
  readonly charged: boolean;
}

export interface SettleChoice {
  readonly voucher: StoredChannelVoucher;
  readonly fromSettled: bigint;
  readonly charge: bigint;
  readonly waived: bigint;
  /** The rows this settlement covers, oldest first. */
  readonly rows: readonly ChannelCallRow[];
}

/**
 * The voucher a round settles for one channel (v3 §5.4.4, I18): the newest
 * whose own call and every earlier call are terminal, still settleable at
 * `chainNow + U` (`expiresAt + 7200 > chainNow + U`) and issued no later than
 * `chainNow + 60`. `charge` is the served (charged) rows up to it, `waived` the
 * rest of the step. `null` when there is nothing to settle.
 */
export function chooseSettlement(
  settled: bigint,
  vouchers: readonly StoredChannelVoucher[],
  rows: readonly ChannelCallRow[],
  chainNow: number,
  policy: Pick<ChannelPolicy, 'landingMarginSeconds'>,
): SettleChoice | null {
  const above = [...rows].filter((row) => row.cumulative > settled).sort(byCumulative);
  // The highest cumulative up to which every row is terminal.
  let terminalTo = settled;
  for (const row of above) {
    if (!row.terminal) break;
    terminalTo = row.cumulative;
  }
  const usable = vouchers
    .filter(
      (voucher) =>
        voucher.cumulative > settled &&
        voucher.cumulative <= terminalTo &&
        voucher.expiresAt + CHANNEL_REDEEM_GRACE_SECONDS > chainNow + policy.landingMarginSeconds &&
        voucher.issuedAt <= chainNow + CHANNEL_SETTLE_FUTURE_ISSUE_SECONDS &&
        voucher.expiresAt > voucher.issuedAt,
    )
    .sort((a, b) =>
      a.cumulative === b.cumulative
        ? b.issuedAt - a.issuedAt
        : a.cumulative > b.cumulative
          ? -1
          : 1,
    );
  const voucher = usable[0];
  if (!voucher) return null;
  const covered = above.filter((row) => row.cumulative <= voucher.cumulative);
  const charge = covered.filter((row) => row.charged).reduce((sum, row) => sum + row.price, 0n);
  const step = voucher.cumulative - settled;
  if (charge > step) {
    // The rows priced more than the signed step: never charge beyond what was signed.
    throw new Error(`channel rows charge ${charge} above the signed step ${step}`);
  }
  return { voucher, fromSettled: settled, charge, waived: step - charge, rows: covered };
}

function byCumulative(a: { cumulative: bigint }, b: { cumulative: bigint }): number {
  return a.cumulative === b.cumulative ? 0 : a.cumulative < b.cumulative ? -1 : 1;
}

/** The newest stored voucher that can still be settled at `chainNow` (for the deadline `D`). */
export function newestUsableExpiry(
  settled: bigint,
  vouchers: readonly StoredChannelVoucher[],
  chainNow: number,
): number | null {
  let best: StoredChannelVoucher | null = null;
  for (const voucher of vouchers) {
    if (voucher.cumulative <= settled) continue;
    if (voucher.expiresAt + CHANNEL_REDEEM_GRACE_SECONDS <= chainNow) continue;
    if (!best || voucher.cumulative > best.cumulative) best = voucher;
  }
  return best ? best.expiresAt : null;
}

// ── Buckets (the contract's placement rule, to plan collect-first) ──────────

export type BucketPlacement = 'B1' | 'B2' | 'FOLD' | 'NO_BUCKET';

/**
 * Where the contract would place a charge settled at `nowTs` (ChannelDoor
 * `_settleOne` step 8 and `_fold`). Used to predict `NoBucket` and to know a
 * matured bucket must be collected first; the pre-simulation stays the proof.
 */
export function placeCharge(
  slot: ChannelSlot,
  nowTs: number,
  holdSeconds: number,
  takeRateBps: number,
  charge: bigint,
): BucketPlacement {
  if (charge === 0n) return 'B1';
  const m = Math.ceil((nowTs + holdSeconds) / CHANNEL_GRID_SECONDS);
  const r = takeRateBps;
  if (slot.h1 !== 0n && slot.m1 === m && slot.r1 === r) {
    return slot.h1 + charge > CHANNEL_MAX_BUCKET ? 'NO_BUCKET' : 'B1';
  }
  if (slot.h2 !== 0n && slot.m2 === m && slot.r2 === r) {
    return slot.h2 + charge > CHANNEL_MAX_BUCKET ? 'NO_BUCKET' : 'B2';
  }
  if (slot.h1 === 0n) return charge > CHANNEL_MAX_BUCKET ? 'NO_BUCKET' : 'B1';
  if (slot.h2 === 0n) return charge > CHANNEL_MAX_BUCKET ? 'NO_BUCKET' : 'B2';
  const one = slot.r1 === r && (slot.r2 !== r || slot.m1 >= slot.m2);
  if (!one && slot.r2 !== r) return 'NO_BUCKET';
  const mOld = one ? slot.m1 : slot.m2;
  if (mOld * CHANNEL_GRID_SECONDS <= nowTs) return 'NO_BUCKET';
  const otherR = one ? slot.r2 : slot.r1;
  const otherM = one ? slot.m2 : slot.m1;
  if (otherR !== r && otherM * CHANNEL_GRID_SECONDS > nowTs) return 'NO_BUCKET';
  const h = one ? slot.h1 : slot.h2;
  return h + charge > CHANNEL_MAX_BUCKET ? 'NO_BUCKET' : 'FOLD';
}

/** Σ of the buckets the redeemer may collect at `nowTs` (maturity reached). */
export function maturedAmount(slot: ChannelSlot, nowTs: number): bigint {
  let total = 0n;
  if (slot.h1 !== 0n && slot.m1 * CHANNEL_GRID_SECONDS <= nowTs) total += slot.h1;
  if (slot.h2 !== 0n && slot.m2 * CHANNEL_GRID_SECONDS <= nowTs) total += slot.h2;
  return total;
}

/**
 * The bucket to refund `amount` from (v3 §3.5: newest maturity first), inside
 * its refund window (`m·3600 + HELD_TIMEOUT > now`), or `null`.
 */
export function refundBucket(
  slot: ChannelSlot,
  amount: bigint,
  nowTs: number,
): { maturityHour: number; takeRateBps: number } | null {
  const buckets = [
    { h: slot.h1, m: slot.m1, r: slot.r1 },
    { h: slot.h2, m: slot.m2, r: slot.r2 },
  ]
    .filter((b) => b.h >= amount && b.h > 0n)
    .filter((b) => b.m * CHANNEL_GRID_SECONDS + CHANNEL_HELD_TIMEOUT_SECONDS > nowTs)
    .sort((a, b) => b.m - a.m);
  return buckets[0] ? { maturityHour: buckets[0].m, takeRateBps: buckets[0].r } : null;
}

/**
 * The next piece of a refund of `remaining` (final review 2026-11-01 MF-1 /
 * X-1): a collect pays oldest first, so the money a dispute keeps may sit
 * partly in each bucket. One bucket that holds it all is used whole (the
 * single-piece refund, {@link refundBucket}); otherwise the newest in-window
 * bucket gives what it holds and the rest comes from the older one in a later
 * piece. `null` when the in-window buckets together hold less than
 * `remaining`: no piece is started that could not be completed.
 */
export function nextRefundPiece(
  slot: ChannelSlot,
  remaining: bigint,
  nowTs: number,
): { maturityHour: number; takeRateBps: number; amount: bigint } | null {
  if (remaining <= 0n) return null;
  const whole = refundBucket(slot, remaining, nowTs);
  if (whole) return { ...whole, amount: remaining };
  const open = [
    { h: slot.h1, m: slot.m1, r: slot.r1 },
    { h: slot.h2, m: slot.m2, r: slot.r2 },
  ]
    .filter((b) => b.h > 0n)
    .filter((b) => b.m * CHANNEL_GRID_SECONDS + CHANNEL_HELD_TIMEOUT_SECONDS > nowTs)
    .sort((a, b) => b.m - a.m);
  if (open.reduce((sum, b) => sum + b.h, 0n) < remaining) return null;
  const newest = open[0];
  return { maturityHour: newest.m, takeRateBps: newest.r, amount: newest.h };
}

/** Σ of the non-empty buckets still inside their refund window at `nowTs`. */
export function refundableAmount(slot: ChannelSlot, nowTs: number): bigint {
  return [
    { h: slot.h1, m: slot.m1 },
    { h: slot.h2, m: slot.m2 },
  ]
    .filter((b) => b.h > 0n && b.m * CHANNEL_GRID_SECONDS + CHANNEL_HELD_TIMEOUT_SECONDS > nowTs)
    .reduce((sum, b) => sum + b.h, 0n);
}

/** The earliest refund deadline among non-empty buckets (receipts: "refund window"). */
export function earliestRefundDeadline(slot: ChannelSlot): number | null {
  const ms = [slot.h1 > 0n ? slot.m1 : null, slot.h2 > 0n ? slot.m2 : null].filter(
    (m): m is number => m !== null,
  );
  if (ms.length === 0) return null;
  return Math.min(...ms) * CHANNEL_GRID_SECONDS + CHANNEL_HELD_TIMEOUT_SECONDS;
}

// ── Collect attribution (FIFO) ──────────────────────────────────────────────

export interface HeldChannelRow {
  readonly intentId: string;
  readonly price: bigint;
  readonly collectableAt: number;
  readonly cumulative: bigint;
  /** Kept by a dispute (`leave`): never attributed to a collect. */
  readonly kept: boolean;
}

/**
 * Which held rows a channel collect of `gross` paid (v3 §5.2: FIFO within a
 * channel, the contract's order). Rows a dispute keeps are skipped: the
 * collect left exactly their sum. Returns the rows paid and any remainder the
 * rows did not account for (a mirror gap: alerted, never booked).
 */
export function attributeCollect(
  rows: readonly HeldChannelRow[],
  gross: bigint,
): { paid: readonly HeldChannelRow[]; unattributed: bigint } {
  const queue = rows
    .filter((row) => !row.kept)
    .sort((a, b) =>
      a.collectableAt !== b.collectableAt ? a.collectableAt - b.collectableAt : byCumulative(a, b),
    );
  const paid: HeldChannelRow[] = [];
  let left = gross;
  for (const row of queue) {
    if (row.price > left) break;
    paid.push(row);
    left -= row.price;
  }
  return { paid, unattributed: left };
}

// ── Payout cadence (SPEC-W2 §8) ─────────────────────────────────────────────

/** The next 6-hour grid point (00, 06, 12, 18 UTC) strictly after `nowSeconds`. */
export function nextSixHourSlot(nowSeconds: number): number {
  const six = 6 * 3_600;
  return (Math.floor(nowSeconds / six) + 1) * six;
}

export function nextHourSlot(nowSeconds: number): number {
  return (Math.floor(nowSeconds / 3_600) + 1) * 3_600;
}

/**
 * Whether a provider on `cadence` is due a payout of its per-call holds and
 * idle channels at `nowSeconds`, given what is ready and when it was last paid.
 * `HOURLY` pays on the hour grid only when at least the minimum is ready, and
 * otherwise falls back to the 6-hour grid; `EVERY_6_HOURS` pays on the 6-hour
 * grid. A run is due once its grid point has passed since the last payout.
 */
export function payoutDue(
  cadence: PayoutCadence,
  readyAtomic: bigint,
  lastPayoutAt: number | null,
  nowSeconds: number,
  minimumAtomic: bigint,
): boolean {
  if (readyAtomic <= 0n) return false;
  const lastSix = Math.floor(nowSeconds / (6 * 3_600)) * 6 * 3_600;
  const lastHour = Math.floor(nowSeconds / 3_600) * 3_600;
  const since = lastPayoutAt ?? 0;
  if (since < lastSix) return true;
  return cadence === 'HOURLY' && readyAtomic >= minimumAtomic && since < lastHour;
}

/** When the next payout will run (for "Next payout about HH:MM UTC"). */
export function nextPayoutAt(
  cadence: PayoutCadence,
  readyAtomic: bigint,
  nowSeconds: number,
  minimumAtomic: bigint,
): number {
  if (cadence === 'HOURLY' && readyAtomic >= minimumAtomic) return nextHourSlot(nowSeconds);
  return nextSixHourSlot(nowSeconds);
}

/** One door's payout inputs for {@link nextPayoutAtByDoor}. */
export interface DoorPayoutInputs {
  readonly perCall: {
    readonly ready: bigint;
    readonly oldestReadyAt: number | null;
    readonly holdEndsAt: number | null;
  };
  readonly channel: {
    readonly ready: bigint;
    readonly holdEndsAt: number | null;
    /** A channel with value still to settle: collected first, every tick, once matured. */
    readonly active: boolean;
  };
}

/**
 * The next payout, the earliest over the two doors (review 2026-10-31 M2),
 * never before the earliest hold end; `null` when neither door has anything
 * ready or in a hold.
 *
 * - Per call: collected once the asset gathered `minBatch` items or the oldest
 *   ready one waited `maxWaitSeconds` (6 h) — an upper bound; `HOURLY` with the
 *   minimum ready → the next hour after the hold end.
 * - Channel: an ACTIVE channel's matured bucket is collected on the next tick
 *   after it matures; an idle one on the cadence grid after the hold end.
 */
export function nextPayoutAtByDoor(
  cadence: PayoutCadence,
  doors: DoorPayoutInputs,
  nowSeconds: number,
  minimumAtomic: bigint,
  maxWaitSeconds: number,
  tickSeconds: number,
): number | null {
  const candidates: number[] = [];
  const pc = doors.perCall;
  if (pc.ready > 0n || pc.holdEndsAt !== null) {
    const base = Math.max(nowSeconds, pc.ready > 0n ? nowSeconds : (pc.holdEndsAt ?? nowSeconds));
    const oldest = pc.ready > 0n ? (pc.oldestReadyAt ?? nowSeconds) : base;
    let at = Math.max(base, oldest + maxWaitSeconds);
    if (cadence === 'HOURLY' && pc.ready + doors.channel.ready >= minimumAtomic) {
      at = Math.min(at, nextHourSlot(base));
    }
    candidates.push(at);
  }
  const ch = doors.channel;
  if (ch.ready > 0n || ch.holdEndsAt !== null) {
    const base = Math.max(nowSeconds, ch.ready > 0n ? nowSeconds : (ch.holdEndsAt ?? nowSeconds));
    candidates.push(
      ch.active
        ? base + tickSeconds
        : cadence === 'HOURLY' && ch.ready + pc.ready >= minimumAtomic
          ? nextHourSlot(base)
          : nextSixHourSlot(base),
    );
  }
  return candidates.length === 0 ? null : Math.min(...candidates);
}

// ── Reservation (SPEC-W2 §4, POLICY §2.3) ───────────────────────────────────

export interface ReservationInputs {
  /** The escrow balance read at `B`, less any requested withdrawal. */
  readonly availableAtomic: bigint;
  /** Σ pending (both doors) already promised against it, this call excluded. */
  readonly pendingAtomic: bigint;
  readonly priceAtomic: bigint;
}

/** Whether admitting this call takes the payer's reservation to the urgent share (80%). */
export function reservationUrgent(input: ReservationInputs, urgentBps: number): boolean {
  if (input.availableAtomic <= 0n) return true;
  return (
    (input.pendingAtomic + input.priceAtomic) * 10_000n >= input.availableAtomic * BigInt(urgentBps)
  );
}
