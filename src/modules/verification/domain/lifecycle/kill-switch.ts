/**
 * Kill-switch targets and the matching rule.
 *
 * The requirement: *"A wrong policy in production is an incident
 * that takes money from innocent people. It must be possible to switch it off
 * without a deploy."*
 *
 * "Without a deploy" is the requirement that decides the shape. The kill list
 * lives in Redis, is written by an operator action, and is read from a local
 * snapshot that every process refreshes — by pub/sub for the fast path and by a
 * poll for the case where the pub/sub message was lost. The read itself is
 * **synchronous**, because it happens on the verification path of every call
 * and a round trip per call would make the switch a latency decision instead of
 * a safety one. The cost of that choice is that the switch is eventually
 * consistent, and the SLA is therefore *seconds*, bounded by the poll interval
 * — which is exactly what the requirement asks for.
 *
 * This file is the pure half: what a target is, what key it occupies, and which
 * keys cover a given policy version. The Redis half is
 * `services/redis-policy-kill-switch.service.ts`.
 */

export enum KillScope {
  /**
   * Every policy, everywhere. The panic button.
   *
   * For the incident where the bad thing is not one policy — a verifier
   * deployment gone wrong, a mapping change that makes every response look
   * malformed. It costs nothing but verification coverage: with everything
   * withdrawn, every call settles and nobody is struck.
   */
  GLOBAL = 'GLOBAL',
  /** Every version of one policy. */
  POLICY = 'POLICY',
  /**
   * One version of one policy.
   *
   * The common case, and the one to reach for first: a bad `v4` is killed
   * while `v3` — which was fine last week — keeps enforcing.
   */
  POLICY_VERSION = 'POLICY_VERSION',
}

export interface KillTarget {
  readonly scope: KillScope;
  /** Required unless {@link KillScope.GLOBAL}. */
  readonly policyId?: string;
  /** Required for {@link KillScope.POLICY_VERSION}. */
  readonly version?: number;
}

/** What an operator's action leaves behind. Stored in Redis, read on every call. */
export interface KillRecord {
  /** {@link killKey} of the target. The Redis hash field. */
  readonly key: string;
  readonly scope: KillScope;
  readonly policyId: string | null;
  readonly version: number | null;
  /** Why. Printed on the receipt of every call the withdrawal affects. */
  readonly reason: string;
  /** Who pulled it. */
  readonly actor: string;
  /** ISO-8601. */
  readonly killedAt: string;
}

export const GLOBAL_KILL_KEY = 'all';

/** The canonical key for a target. Stable — it is what Redis stores. */
export function killKey(target: KillTarget): string {
  switch (target.scope) {
    case KillScope.GLOBAL:
      return GLOBAL_KILL_KEY;
    case KillScope.POLICY:
      return `policy:${requirePolicyId(target)}`;
    case KillScope.POLICY_VERSION:
      return `policy:${requirePolicyId(target)}@${requireVersion(target)}`;
  }
}

function requirePolicyId(target: KillTarget): string {
  if (!target.policyId) {
    throw new Error(`A ${target.scope} kill target needs a policyId`);
  }
  return target.policyId;
}

function requireVersion(target: KillTarget): number {
  if (target.version === undefined || target.version === null) {
    throw new Error(`A ${target.scope} kill target needs a version`);
  }
  return target.version;
}

/**
 * Every key whose presence withdraws this policy version, broadest first.
 *
 * Broadest first so that a global halt is the reason reported during an
 * incident, rather than an incidental per-version kill that happens to also
 * cover this call. During an outage the operator wants to see their own
 * "halting everything, bad verifier deploy" on the receipt.
 */
export function keysCovering(policyId: string, version: number): readonly string[] {
  return [GLOBAL_KILL_KEY, `policy:${policyId}`, `policy:${policyId}@${version}`];
}

/** The record that withdraws this version, or `null`. Pure lookup over a snapshot. */
export function findKill(
  snapshot: ReadonlyMap<string, KillRecord>,
  policyId: string,
  version: number,
): KillRecord | null {
  for (const key of keysCovering(policyId, version)) {
    const record = snapshot.get(key);
    if (record) return record;
  }
  return null;
}
