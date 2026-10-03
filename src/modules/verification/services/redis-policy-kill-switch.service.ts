/**
 * The kill switch, on Redis.
 *
 * ```text
 *  operator ──kill()──▶ HSET verification:killswitch  (durable)
 *                       PUBLISH …:changed             (fast path)
 *                              │
 *          ┌───────────────────┼───────────────────┐
 *          ▼                   ▼                   ▼
 *      api pod 1           api pod 2           worker pod
 *      subscriber          subscriber          subscriber      ~ms
 *      + poll 2s           + poll 2s           + poll 2s       ≤ pollIntervalMs
 *          │                   │                   │
 *      local snapshot ── isKilled() is a Map lookup, no I/O
 * ```
 *
 * **Two paths, on purpose.** Pub/sub is fire-and-forget: Redis does not
 * persist a message for a subscriber that was mid-reconnect, so a switch built
 * on pub/sub alone has a failure mode where one pod never hears and keeps
 * enforcing the policy an operator believes they pulled. The poll is what makes
 * the SLA a bound rather than a hope — the fast path is an optimisation on top
 * of it, not the mechanism. Killing the pub/sub entirely leaves the switch
 * correct and slower, which is the right way round.
 *
 * **A stale snapshot withdraws everything.** If this process cannot refresh for
 * `staleAfterMs`, it stops trusting its own list and reports every policy as
 * withdrawn. That is a deliberately expensive failure: an unreachable Redis
 * turns verification off platform-wide, every call settles and nobody is
 * struck. The alternative is to keep enforcing a list we can no longer confirm,
 * during exactly the incident in which somebody is likely to be trying to pull
 * a policy — which is the scenario the kill switch exists to prevent. Losing quality
 * signal costs us a metric; enforcing a policy we were told to stop enforcing
 * costs an innocent provider money.
 */

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';

import {
  KillRecord,
  KillScope,
  KillTarget,
  findKill,
  killKey,
} from '../domain/lifecycle/kill-switch';
import { PolicyKillSwitchPort } from '../ports/policy-kill-switch.port';

/** The command client. A second, subscribed client cannot run commands. */
export const KILL_SWITCH_REDIS = 'KILL_SWITCH_REDIS';
/** The subscriber client. Dedicated — ioredis puts it into subscriber mode. */
export const KILL_SWITCH_SUBSCRIBER = 'KILL_SWITCH_SUBSCRIBER';
export const KILL_SWITCH_CONFIG = 'KILL_SWITCH_CONFIG';

export interface KillSwitchConfig {
  /** Redis key of the hash, and the base of the pub/sub channel name. */
  readonly namespace: string;
  /**
   * The SLA, effectively. An operator is told the switch takes effect within
   * this bound plus one round trip, and the pub/sub path usually beats it by
   * three orders of magnitude.
   */
  readonly pollIntervalMs: number;
  /** Beyond this age the snapshot is not trusted. See the file header. */
  readonly staleAfterMs: number;
  /** Injected so a test can measure staleness without waiting for it. */
  readonly now: () => number;
}

export const DEFAULT_KILL_SWITCH_CONFIG: Omit<KillSwitchConfig, 'now'> = Object.freeze({
  namespace: 'verification:killswitch',
  pollIntervalMs: 2_000,
  staleAfterMs: 30_000,
});

@Injectable()
export class RedisPolicyKillSwitchService
  implements PolicyKillSwitchPort, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedisPolicyKillSwitchService.name);

  private snapshot: ReadonlyMap<string, KillRecord> = new Map();
  /** `0` means "never successfully loaded", which reads as maximally stale. */
  private refreshedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(
    @Inject(KILL_SWITCH_REDIS) private readonly redis: Redis,
    @Inject(KILL_SWITCH_SUBSCRIBER) private readonly subscriber: Redis,
    @Inject(KILL_SWITCH_CONFIG) private readonly config: KillSwitchConfig,
  ) {}

  private get channel(): string {
    return `${this.config.namespace}:changed`;
  }

  async onModuleInit(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Awaited: a process that starts serving before it knows the kill list
    // would enforce a policy an operator pulled an hour ago. A failure here is
    // logged rather than thrown — `snapshotAgeMs` already makes an unloaded
    // snapshot withdraw everything, which is safer than refusing to boot.
    await this.refresh().catch((error) => {
      this.logger.error('Kill-switch snapshot could not be loaded at boot', error as Error);
    });

    await this.subscriber.subscribe(this.channel);
    this.subscriber.on('message', (channel) => {
      if (channel !== this.channel) return;
      void this.refresh().catch((error) => {
        this.logger.warn(`Kill-switch refresh on broadcast failed: ${String(error)}`);
      });
    });

    this.timer = setInterval(() => {
      void this.refresh().catch((error) => {
        this.logger.warn(`Kill-switch poll failed: ${String(error)}`);
      });
    }, this.config.pollIntervalMs);
    // Never hold the process open for a poll.
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.subscriber.unsubscribe(this.channel).catch(() => undefined);
  }

  isKilled(policyId: string, version: number): KillRecord | null {
    const age = this.snapshotAgeMs();
    if (age > this.config.staleAfterMs) {
      return this.staleSnapshotWithdrawal(age);
    }
    return findKill(this.snapshot, policyId, version);
  }

  async kill(target: KillTarget, reason: string, actor: string): Promise<KillRecord> {
    const record: KillRecord = {
      key: killKey(target),
      scope: target.scope,
      policyId: target.policyId ?? null,
      version: target.version ?? null,
      reason,
      actor,
      // Wall clock, not `config.now`: this is a durable audit field read by
      // humans and by the evidence pack, and it has to agree with every other
      // timestamp in the incident. `config.now` exists to let a test age a
      // snapshot, and ageing a snapshot must not rewrite history.
      killedAt: new Date().toISOString(),
    };

    await this.redis.hset(this.config.namespace, record.key, JSON.stringify(record));
    await this.redis.publish(this.channel, record.key);

    // The killing process is current immediately; everyone else is current
    // within the bound. Without this, an operator calling `kill()` then
    // `isKilled()` through the same instance could still be told "no".
    await this.refresh();

    this.logger.warn(`Kill switch engaged on ${record.key} by ${actor}: ${reason}`);
    return record;
  }

  async revive(target: KillTarget, actor: string): Promise<boolean> {
    const key = killKey(target);
    const removed = await this.redis.hdel(this.config.namespace, key);
    await this.redis.publish(this.channel, key);
    await this.refresh();

    if (removed > 0) {
      this.logger.warn(`Kill switch released on ${key} by ${actor}`);
    }
    return removed > 0;
  }

  list(): readonly KillRecord[] {
    return [...this.snapshot.values()];
  }

  snapshotAgeMs(): number {
    if (this.refreshedAt === 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.config.now() - this.refreshedAt);
  }

  async refresh(): Promise<void> {
    const raw = await this.redis.hgetall(this.config.namespace);

    const next = new Map<string, KillRecord>();
    for (const [key, value] of Object.entries(raw ?? {})) {
      const record = parseRecord(key, value);
      if (record) {
        next.set(key, record);
      } else {
        // An unparseable entry is still an instruction to stop enforcing
        // something, and the safe reading of a corrupt kill record is that the
        // kill stands.
        this.logger.error(`Kill-switch entry ${key} is unreadable; treating it as engaged`);
        next.set(key, unreadableRecord(key));
      }
    }

    this.snapshot = next;
    this.refreshedAt = this.config.now();
  }

  private staleSnapshotWithdrawal(ageMs: number): KillRecord {
    return {
      key: 'stale-snapshot',
      scope: KillScope.GLOBAL,
      policyId: null,
      version: null,
      reason:
        `The kill list could not be refreshed for ${Math.round(ageMs / 1000)}s, so no policy ` +
        `is enforced. Verification is unavailable; nobody is charged for it.`,
      actor: 'system',
      killedAt: new Date(this.config.now()).toISOString(),
    };
  }
}

function parseRecord(key: string, value: string): KillRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<KillRecord>;
    if (typeof parsed.reason !== 'string' || typeof parsed.actor !== 'string') return null;

    return {
      key,
      scope: parsed.scope ?? KillScope.POLICY,
      policyId: parsed.policyId ?? null,
      version: parsed.version ?? null,
      reason: parsed.reason,
      actor: parsed.actor,
      killedAt: parsed.killedAt ?? new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function unreadableRecord(key: string): KillRecord {
  return {
    key,
    scope: KillScope.POLICY,
    policyId: null,
    version: null,
    reason: 'This policy was withdrawn; the withdrawal record could not be read.',
    actor: 'unknown',
    killedAt: new Date(0).toISOString(),
  };
}
