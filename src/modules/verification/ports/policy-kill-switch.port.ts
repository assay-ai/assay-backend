/**
 * The kill switch, as a port.
 *
 * A port rather than a concrete service for one reason that is not testing:
 * `isKilled` is on the hot path of every verified call, and the signature is
 * what enforces that. It returns **synchronously**, so no implementation can
 * quietly make it a network round trip per call — the pressure to do exactly
 * that is real, because a per-call read is the obvious way to make a switch
 * take effect instantly, and it would put Redis latency in front of every
 * settlement decision and Redis availability in front of every payment.
 *
 * The design instead is: writes go to Redis and are broadcast; every process
 * keeps a local snapshot; reads are local. The switch is eventually consistent
 * with a bound measured in seconds, which is the SLA the kill switch requires.
 */

import { KillRecord, KillTarget } from '../domain/lifecycle/kill-switch';

export const POLICY_KILL_SWITCH = 'POLICY_KILL_SWITCH';

export interface PolicyKillSwitchPort {
  /**
   * The record withdrawing this policy version, or `null`.
   *
   * Synchronous and local. See the file header.
   */
  isKilled(policyId: string, version: number): KillRecord | null;

  /**
   * Withdraw a policy. Takes effect in every process within the refresh bound.
   *
   * Resolves once the write is durable in Redis and the broadcast has been
   * sent — **not** once every process has observed it, which is not knowable
   * from here. `refreshedAt` on each process is how that is measured.
   */
  kill(target: KillTarget, reason: string, actor: string): Promise<KillRecord>;

  /** Put a withdrawn policy back. Returns whether anything was withdrawn. */
  revive(target: KillTarget, actor: string): Promise<boolean>;

  /** Everything currently withdrawn, for the console and the incident review. */
  list(): readonly KillRecord[];

  /**
   * How old this process's snapshot is, in ms.
   *
   * Exposed rather than internal because it is the number the SLA is stated in
   * and the number an alert fires on. A snapshot older than the staleness bound
   * means this process can no longer be trusted to know what has been
   * withdrawn — see the implementation for what it does about that.
   */
  snapshotAgeMs(): number;

  /**
   * Force a refresh and resolve when the snapshot is current.
   *
   * For the operator flow — after `kill()` returns, an operator wants to be
   * able to *demonstrate* the switch took effect — and for tests that measure
   * propagation. Not on the hot path.
   */
  refresh(): Promise<void>;
}
