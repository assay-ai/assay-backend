import { createHash } from 'node:crypto';

import type { SlashRecordSnapshot } from '../ports/slash-executor.port';

/**
 * A window-level SLA penalty, split into one judgement per harmed agent.
 *
 * ## Why one judgement per agent
 *
 * The product rule for a window-level slash is that the harmed agents are
 * compensated **pro rata**, on chain, by the contract itself: the agent share
 * (60%) of each judgement is paid straight to the agent's own account by
 * `executeSlash`, the platform share (30%) to the treasury, and the provider
 * keeps the remaining 10%. A `SlashAttestation` names exactly one
 * `beneficiary`, so "pro rata on chain" can only mean one attestation per
 * agent, each carrying that agent's share of the window penalty as its
 * `penalty`.
 *
 * The weight is the **price of the agent's DATA_FAIL calls in the window** —
 * what the provider was paid (or would have been) for the bad answers that
 * agent received. An agent whose failures were all free calls has weight zero
 * and is not a beneficiary.
 *
 * ## The properties that carry the money
 *
 * - **Exact.** The parts sum to exactly the total that is signed for. Shares
 *   are floored and the remainder is handed out one minor unit at a time,
 *   largest fractional part first (the largest-remainder method). Ties break on
 *   the agent account ascending, so the answer never depends on row order.
 * - **Bounded by the contract.** `proposeSlash` refuses a `penalty` above
 *   `params.penaltyAmount`, and the provider's rolling window admits at most
 *   `slashCapBps` of the stake at risk; `executeSlash` also stops at the
 *   verifier key's daily cap. When any of these binds, the WHOLE plan is
 *   scaled down — the total is reduced and re-split by the same weights — so
 *   no agent's share is clipped while another's is not. What bound is
 *   recorded in {@link ProRataPlan.binding}, and every part keeps its
 *   uncapped share beside its signed penalty.
 * - **Never zero, never dust the chain cannot pay.** `executeSlash` reverts
 *   `PenaltyTooSmallToSplit` when neither the agent nor the platform share of
 *   `applied` reaches one unit, and `proposeSlash` reverts `ZeroAmount` on a
 *   zero penalty. A share below {@link ProRataCaps.minimumPart} is therefore
 *   left out (and listed in {@link ProRataPlan.unpaid}) rather than proposed as
 *   a judgement that could never execute — and the same total is re-split
 *   among the remaining agents, so the parts still sum to what was decided.
 *
 * Pure: no repository, no clock, no chain SDK. `bigint` throughout — there is
 * no `Number(...)` on a money value in this file.
 */

/** One harmed agent and what its failed calls in the window were priced at. */
export interface HarmedAgentWeight {
  /** CAIP-10. On EVM, the buyer's own account — the address the 60% is paid to. */
  readonly agentAccount: string;
  /** Σ `price_amount` of the agent's DATA_FAIL calls in the window, minor units. */
  readonly weight: bigint;
}

/** The on-chain ceilings a plan must fit inside, all in minor units. */
export interface ProRataCaps {
  /** `params.penaltyAmount`: the largest `penalty` one attestation may carry. */
  readonly perPartCeiling: bigint;
  /**
   * The most all the parts together may take. The caller passes the smallest
   * of the provider's per-window allowance (`atRisk × slashCapBps`), the stake
   * not already reserved by other judgements, and the verifier key's daily cap.
   */
  readonly totalCeiling: bigint;
  /**
   * The smallest part the contract can ever pay —
   * {@link minimumSplittablePenalty} (2 units at 60/30). A smaller part would
   * revert `PenaltyTooSmallToSplit` at every execution until it expired, so
   * it is left out and its share RE-SPLIT among the other agents by the same
   * weights: the total signed for is unchanged.
   */
  readonly minimumPart: bigint;
}

/** What reduced a plan below the window penalty, if anything. */
export enum ProRataCapBinding {
  NONE = 'NONE',
  /** The provider's per-window allowance, free stake or the verifier daily cap. */
  TOTAL_CEILING = 'TOTAL_CEILING',
  /** `penaltyAmount`: the largest share had to fit one attestation. */
  PART_CEILING = 'PART_CEILING',
  /** Only that a share below `minimumPart` was left out and re-split among the rest. */
  DUST_FLOOR = 'DUST_FLOOR',
}

export interface ProRataPart {
  readonly agentAccount: string;
  readonly weight: bigint;
  /** This agent's exact share of the window penalty, before any cap. */
  readonly uncappedShare: bigint;
  /** What the attestation is signed for. `> 0`, `≤ perPartCeiling`. */
  readonly penalty: bigint;
}

export interface ProRataPlan {
  readonly windowPenalty: bigint;
  /** Σ `parts[].penalty`, exactly. */
  readonly cappedTotal: bigint;
  readonly binding: ProRataCapBinding;
  /** Sorted by `agentAccount`. Only parts with a penalty to propose. */
  readonly parts: readonly ProRataPart[];
  /** Harmed agents left out because their share was below `minimumPart`. */
  readonly unpaid: readonly ProRataPart[];
}

/**
 * Split `total` across `rows` in proportion to `weight`, exactly.
 *
 * Every key gets an entry, zero included. Refuses negative inputs and a
 * duplicated key: two rows for one account would pay that account twice and
 * the caller must merge them first.
 */
export function allocateLargestRemainder(
  total: bigint,
  rows: readonly { readonly key: string; readonly weight: bigint }[],
): Map<string, bigint> {
  if (total < 0n) throw new Error(`cannot allocate a negative total (${total})`);
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.weight < 0n) throw new Error(`weight for ${row.key} is negative (${row.weight})`);
    if (seen.has(row.key)) throw new Error(`duplicate key ${row.key} in an allocation`);
    seen.add(row.key);
  }

  const shares = new Map<string, bigint>(rows.map((row) => [row.key, 0n] as const));
  const weightTotal = rows.reduce((sum, row) => sum + row.weight, 0n);
  if (total === 0n || weightTotal === 0n) return shares;

  // Floor first, and keep each remainder as a numerator over `weightTotal` so
  // the comparison stays in integers.
  const floored = rows.map((row) => {
    const scaled = row.weight * total;
    return { key: row.key, amount: scaled / weightTotal, remainder: scaled % weightTotal };
  });
  let handedOut = floored.reduce((sum, row) => sum + row.amount, 0n);

  // Fewer than `rows.length` units are ever left over, so one pass suffices.
  const byRemainder = [...floored].sort(
    (left, right) =>
      compareBigInt(right.remainder, left.remainder) || compareStrings(left.key, right.key),
  );
  for (const row of byRemainder) {
    if (handedOut >= total) break;
    row.amount += 1n;
    handedOut += 1n;
  }

  for (const row of floored) shares.set(row.key, row.amount);
  return shares;
}

/**
 * The pro-rata plan for one window-level penalty. See the file header.
 *
 * Returns an empty plan — never throws — when there is nothing owed or nobody
 * to owe it to: a cap can reduce a penalty to nothing, and a window can close
 * with every failure on a free call. Whether an empty plan is acceptable is
 * the caller's decision.
 */
export function planProRataSlash(input: {
  readonly windowPenalty: bigint;
  readonly agents: readonly HarmedAgentWeight[];
  readonly caps: ProRataCaps;
}): ProRataPlan {
  const { windowPenalty, caps } = input;
  if (windowPenalty < 0n) throw new Error(`window penalty is negative (${windowPenalty})`);
  if (caps.perPartCeiling < 0n || caps.totalCeiling < 0n || caps.minimumPart < 1n) {
    throw new Error('caps must be non-negative and the minimum part at least one unit');
  }

  const harmed = input.agents
    .filter((agent) => agent.weight > 0n)
    .map((agent) => ({ key: agent.agentAccount, weight: agent.weight }))
    .sort((left, right) => compareStrings(left.key, right.key));

  const uncapped = allocateLargestRemainder(windowPenalty, harmed);

  // Fixed point: fit the caps, split, drop what the contract can never split,
  // and re-split the SAME total among the rest — then fit the ceiling again,
  // because a redistribution can push the largest share over it. Each round
  // removes at least one agent, so this ends.
  let eligible = harmed;
  let capped = new Map<string, bigint>();
  let binding = ProRataCapBinding.NONE;
  const dropped: typeof harmed = [];
  for (;;) {
    let total = windowPenalty;
    binding = ProRataCapBinding.NONE;
    if (caps.totalCeiling < total) {
      total = caps.totalCeiling;
      binding = ProRataCapBinding.TOTAL_CEILING;
    }
    // The largest total whose largest share still fits one attestation:
    // share(maxWeight) = total × maxWeight / weightTotal ≤ perPartCeiling. Its
    // floor is enough — see `planFitsTheCeiling` for why the rounding unit
    // cannot push the largest share over.
    const weightTotal = eligible.reduce((sum, row) => sum + row.weight, 0n);
    const maxWeight = eligible.reduce((max, row) => (row.weight > max ? row.weight : max), 0n);
    if (maxWeight > 0n) {
      const fitsOneAttestation = (caps.perPartCeiling * weightTotal) / maxWeight;
      if (fitsOneAttestation < total) {
        total = fitsOneAttestation;
        binding = ProRataCapBinding.PART_CEILING;
      }
    }
    capped = allocateLargestRemainder(total, eligible);
    const tooSmall = eligible.filter((row) => (capped.get(row.key) ?? 0n) < caps.minimumPart);
    if (tooSmall.length === 0 || tooSmall.length === eligible.length) {
      if (tooSmall.length === eligible.length) {
        dropped.push(...tooSmall);
        eligible = [];
        capped = new Map();
      }
      break;
    }
    dropped.push(...tooSmall);
    eligible = eligible.filter((row) => !tooSmall.includes(row));
  }

  const parts: ProRataPart[] = eligible.map((row) => ({
    agentAccount: row.key,
    weight: row.weight,
    uncappedShare: uncapped.get(row.key) ?? 0n,
    penalty: capped.get(row.key) ?? 0n,
  }));
  const unpaid: ProRataPart[] = dropped
    .map((row) => ({
      agentAccount: row.key,
      weight: row.weight,
      uncappedShare: uncapped.get(row.key) ?? 0n,
      penalty: 0n,
    }))
    .sort((left, right) => compareStrings(left.agentAccount, right.agentAccount));

  if (binding === ProRataCapBinding.NONE && unpaid.length > 0) {
    binding = ProRataCapBinding.DUST_FLOOR;
  }

  const cappedTotal = parts.reduce((sum, part) => sum + part.penalty, 0n);
  planFitsTheCeiling(parts, caps);

  return { windowPenalty, cappedTotal, binding, parts, unpaid };
}

/**
 * The postcondition, asserted rather than trusted.
 *
 * The argument that it always holds: with `total ≤ C·W/maxW` the largest
 * share's exact value is at most `C`. If it is exactly `C` its remainder is
 * zero, and a zero-remainder row only receives a rounding unit once every row
 * with a positive remainder has one — which needs more spare units than there
 * are such rows, and there never are. If it is below `C` its floor is at most
 * `C − 1`. Either way the rounded share is `≤ C`. A plan that broke this would
 * be refused by `proposeSlash` (`PenaltyExceedsMaximum`) and void the case, so
 * it is cheaper to fail here, loudly, before anything is signed.
 */
function planFitsTheCeiling(parts: readonly ProRataPart[], caps: ProRataCaps): void {
  for (const part of parts) {
    if (part.penalty > caps.perPartCeiling || part.penalty <= 0n) {
      throw new Error(
        `pro-rata part for ${part.agentAccount} is ${part.penalty}, outside (0, ${caps.perPartCeiling}]`,
      );
    }
  }
}

/**
 * Parts whose agent share (`⌊penalty·agentBps/10⁴⌋`, what `executeSlash` pays
 * the beneficiary when nothing caps it further) is below `minimumAgentShare`.
 *
 * Reported, never dropped: a tiny share is still owed, and removing or
 * redistributing it is not this function's call. `0n` turns reporting off.
 */
export function findDustParts(
  parts: readonly ProRataPart[],
  agentBps: number,
  minimumAgentShare: bigint,
): readonly ProRataPart[] {
  if (minimumAgentShare <= 0n) return [];
  return parts.filter((part) => (part.penalty * BigInt(agentBps)) / 10_000n < minimumAgentShare);
}

/**
 * The smallest `applied` that `executeSlash` can split without reverting
 * `PenaltyTooSmallToSplit` — the smallest `a` for which
 * `⌊a·agentBps/10⁴⌋ + ⌊a·platformBps/10⁴⌋ ≥ 1`, i.e. `⌈10⁴ / max(bps)⌉`.
 */
export function minimumSplittablePenalty(agentBps: number, platformBps: number): bigint {
  const largest = BigInt(Math.max(agentBps, platformBps));
  if (largest <= 0n) throw new Error('a split with no agent or platform share can never pay');
  return (10_000n + largest - 1n) / largest;
}

/**
 * The on-chain request id of one agent's part of one case.
 *
 * Deterministic in `(window, case request id, agent)`, which is what makes a
 * retried proposal adopt the record it already wrote instead of reserving the
 * stake twice: `proposeSlash` refuses a second record for a request id
 * (`SlashAlreadyExists`), and the adopt path reads it back.
 *
 * The case's own `chain_request_id` is in the preimage because it already
 * carries the case's `chain_epoch`: a re-proposal after a cancel-and-bump must
 * sign under FRESH ids, or every part would collide with its own cancelled
 * record and the case would be closed as voided. The window id makes the
 * derivation say what it is about on its face.
 *
 * An EVM address is lower-cased first — `0xAbC…` and `0xabc…` are one account
 * and must be one id. Other namespaces are case-sensitive and kept verbatim.
 */
export function slashPartRequestId(
  windowId: string,
  caseRequestId: string,
  agentAccount: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(caseRequestId)) {
    throw new Error(`case request id must be 32 bytes of lower-case hex, got "${caseRequestId}"`);
  }
  return createHash('sha256')
    .update('assay:slash-part:v1')
    .update(`|${windowId}|${caseRequestId}|${normalizeAgentAccount(agentAccount)}`)
    .digest('hex');
}

/** `eip155:…:0xABC` → `eip155:…:0xabc`; anything else unchanged. */
export function normalizeAgentAccount(account: string): string {
  return account.startsWith('eip155:') ? account.toLowerCase() : account;
}

/** The chain-facing state of one part, as the parts table mirrors it. */
export type SlashPartChainStatus =
  | 'NONE'
  | 'PENDING'
  | 'DISPUTED'
  | 'EXECUTED'
  | 'CANCELLED'
  | 'REFUSED';

export interface SlashPartView {
  readonly status: SlashPartChainStatus;
  readonly penaltyMinor: string;
  readonly reservedMinor: string | null;
  readonly appliedMinor: string | null;
  readonly agentAmountMinor: string | null;
  readonly platformAmountMinor: string | null;
  readonly proposedAt: Date | null;
  readonly executableAt: Date | null;
  readonly executedAt: Date | null;
  readonly cancelledAt: Date | null;
  /** D-19: the chain's `disputedAt`, when the provider disputed this part's record. */
  readonly disputedAt?: Date | null;
}

const LANDED: ReadonlySet<SlashPartChainStatus> = new Set([
  'PENDING',
  'DISPUTED',
  'EXECUTED',
  'CANCELLED',
]);

/**
 * What a case's judgement is, when it is a set of per-agent records.
 *
 * The case is ONE judgement to the arbitration state machine, so the parts are
 * folded into the one record shape it already reasons about:
 *
 * - `PENDING` while any part is pending — the case is not done, and its
 *   pending parts may execute even while another part is disputed (audit
 *   E-4: a dispute freezes only its own part);
 * - `DISPUTED` when no part is pending and at least one is disputed on chain
 *   (D-19) — nothing of the case can execute until the arbiter rules;
 * - otherwise `EXECUTED` if any part executed — money moved, and a case that
 *   says otherwise would tell the provider a penalty was dropped that was
 *   taken;
 * - otherwise `CANCELLED` if every part that landed was cancelled or expired;
 * - `null` when no part ever reached the chain (never proposed, or every one
 *   refused).
 *
 * Clocks: `proposedAt` is the earliest, `executableAt` the LATEST — the case
 * executes all of its parts in one pass, so it may only be due once every
 * part's door is open. Amounts are sums over the parts that landed (penalty,
 * reserved) or executed (applied and the two shares).
 */
export function aggregateSlashParts(parts: readonly SlashPartView[]): SlashRecordSnapshot | null {
  const landed = parts.filter((part) => LANDED.has(part.status));
  if (landed.length === 0) return null;

  const disputed = landed.filter((part) => part.status === 'DISPUTED');
  const pending = landed.some((part) => part.status === 'PENDING');
  const executed = landed.filter((part) => part.status === 'EXECUTED');
  const status = pending
    ? 'PENDING'
    : disputed.length > 0
      ? 'DISPUTED'
      : executed.length > 0
        ? 'EXECUTED'
        : 'CANCELLED';
  const disputedDates = disputed
    .map((part) => part.disputedAt)
    .filter((date): date is Date => date instanceof Date);

  const sumOf = (rows: readonly SlashPartView[], pick: (row: SlashPartView) => string | null) =>
    rows.reduce((sum, row) => sum + BigInt(pick(row) ?? '0'), 0n).toString();

  const proposedAt = earliest(landed.map((part) => required(part.proposedAt, 'proposedAt')));
  const executableAt = latest(landed.map((part) => required(part.executableAt, 'executableAt')));

  return {
    status,
    penaltyMinor: sumOf(landed, (part) => part.penaltyMinor),
    reservedMinor: sumOf(landed, (part) => part.reservedMinor),
    appliedMinor: sumOf(executed, (part) => part.appliedMinor),
    agentAmountMinor: sumOf(executed, (part) => part.agentAmountMinor),
    platformAmountMinor: sumOf(executed, (part) => part.platformAmountMinor),
    proposedAt,
    executableAt,
    executedAt:
      status === 'EXECUTED'
        ? latest(executed.map((part) => required(part.executedAt, 'executedAt')))
        : null,
    cancelledAt:
      status === 'CANCELLED'
        ? latest(landed.map((part) => part.cancelledAt ?? part.executableAt ?? proposedAt))
        : null,
    disputedAt: disputedDates.length > 0 ? earliest(disputedDates) : null,
  };
}

function required(value: Date | null, field: string): Date {
  if (!value) throw new Error(`a slash part that reached the chain has no ${field}`);
  return value;
}

function earliest(dates: readonly Date[]): Date {
  return new Date(Math.min(...dates.map((date) => date.getTime())));
}

function latest(dates: readonly Date[]): Date {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

/** Code-unit order, not locale order: the same answer on every machine. */
function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The 32-byte `policy` field the EVM attestation signs: SHA-256 of the policy
 * string's UTF-8 bytes (the Solana executor signs the same mapping).
 */
export function policyHashOf(policy: string): `0x${string}` {
  return `0x${createHash('sha256').update(policy, 'utf8').digest('hex')}`;
}

/** The signed terms a record carries, as far as its chain stores them. */
export interface SlashRecordTerms {
  /** Bare address. Absent on a chain whose snapshot does not carry it. */
  readonly beneficiary?: string;
  readonly penaltyMinor: string;
  /** 32-byte hex. Absent when not carried. */
  readonly policy?: string;
  /**
   * Whether the record's verifier is acceptable: this platform's own key, or
   * — key rotation — a key the chain still allows to sign. Absent when the
   * chain cannot say.
   */
  readonly verifierAccepted?: boolean;
}

/**
 * THE one rule for treating a record found at one of our request ids as our
 * judgement — used by the executor before adopting on propose and by the
 * parts service before mirroring anything it reads back.
 *
 * Refused, always: a different beneficiary, penalty or policy. Those are what
 * the verifier signed for this agent; a record with other terms at our id is
 * somebody else's judgement, and adopting it would pay the wrong amount or
 * the wrong account under our name. A different verifier is accepted only
 * while that key may still sign on chain — a rotation — because a revoked
 * key's record can never execute.
 *
 * Returns the first mismatching field, or `null`. Fields a chain's snapshot
 * does not carry are not judged (Solana's record has no policy string to
 * compare against here).
 */
export function slashRecordMismatch(
  record: SlashRecordTerms,
  expected: {
    readonly beneficiary: string;
    readonly penaltyMinor: string;
    readonly policy: string;
  },
): 'beneficiary' | 'penalty' | 'policy' | 'verifier' | null {
  if (
    record.beneficiary !== undefined &&
    record.beneficiary.toLowerCase() !== expected.beneficiary.toLowerCase()
  ) {
    return 'beneficiary';
  }
  if (BigInt(record.penaltyMinor) !== BigInt(expected.penaltyMinor)) return 'penalty';
  if (
    record.policy !== undefined &&
    record.policy.toLowerCase() !== policyHashOf(expected.policy).toLowerCase()
  ) {
    return 'policy';
  }
  if (record.verifierAccepted === false) return 'verifier';
  return null;
}
