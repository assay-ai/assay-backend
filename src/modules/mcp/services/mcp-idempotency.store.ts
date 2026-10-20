import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import { idempotencyKeyDigest } from '../domain/idempotency';

/**
 * The numbers behind `_meta["assay/idempotency-key"]`, injected like
 * `MCP_PRICING` so the retention window is not a deploy.
 */
export interface McpIdempotencyConfig {
  /**
   * How long a completed call's result stays replayable: the retry window.
   * `MCP_IDEMPOTENCY_TTL_SECONDS`, default 900 (15 minutes), at most
   * {@link MCP_IDEMPOTENCY_MAX_TTL_SECONDS} — a stored output is a provider's
   * response held in memory, and the window is for retries, not storage.
   */
  readonly resultTtlSeconds: number;
  /**
   * The largest output kept for a replay, in bytes of its JSON.
   * `MCP_IDEMPOTENCY_MAX_RESULT_BYTES`, default 262144 (256 KB). A larger one
   * is not stored; a marker is, and a replay answers
   * `IDEMPOTENCY_RESULT_UNAVAILABLE` with the intent id.
   */
  readonly maxResultBytes: number;
  /**
   * How long an attempt that never reported back holds its key. Longer than
   * the router's whole deadline (`ROUTER_TOTAL_DEADLINE_MS`, 30 s), so a live
   * call cannot lose its claim; short enough that a crashed process does not
   * hold a key for the whole retry window. A payment intent older than this
   * that is still not past its provider is reported as stalled.
   */
  readonly inFlightLeaseMs: number;
  /**
   * What `IDEMPOTENCY_IN_PROGRESS` tells the agent to wait, in whole seconds —
   * the `retryAfter` convention of the platform's other refusals.
   */
  readonly retryAfterSeconds: number;
}

export const MCP_IDEMPOTENCY_CONFIG = Symbol('MCP_IDEMPOTENCY_CONFIG');

/** The longest retry window a deployment may configure: one hour. */
export const MCP_IDEMPOTENCY_MAX_TTL_SECONDS = 3600;

export const DEFAULT_MCP_IDEMPOTENCY_CONFIG: McpIdempotencyConfig = {
  resultTtlSeconds: 15 * 60,
  maxResultBytes: 256 * 1024,
  inFlightLeaseMs: 120_000,
  retryAfterSeconds: 1,
};

/**
 * `MCP_IDEMPOTENCY_TTL_SECONDS` and `MCP_IDEMPOTENCY_MAX_RESULT_BYTES`.
 * Unset falls back to the default. A value that is not a positive integer, or
 * a window above {@link MCP_IDEMPOTENCY_MAX_TTL_SECONDS}, fails the boot rather
 * than being quietly replaced: an operator who asked for a day of retention
 * must hear that it was refused.
 */
export function mcpIdempotencyConfigFactory(
  ttlSeconds: string | undefined,
  maxResultBytes?: string | undefined,
): McpIdempotencyConfig {
  const ttl = positiveInteger('MCP_IDEMPOTENCY_TTL_SECONDS', ttlSeconds);
  if (ttl !== null && ttl > MCP_IDEMPOTENCY_MAX_TTL_SECONDS) {
    throw new Error(
      `MCP_IDEMPOTENCY_TTL_SECONDS must be at most ${MCP_IDEMPOTENCY_MAX_TTL_SECONDS}, got ${ttl}`,
    );
  }
  const bytes = positiveInteger('MCP_IDEMPOTENCY_MAX_RESULT_BYTES', maxResultBytes);
  return {
    ...DEFAULT_MCP_IDEMPOTENCY_CONFIG,
    resultTtlSeconds: ttl ?? DEFAULT_MCP_IDEMPOTENCY_CONFIG.resultTtlSeconds,
    maxResultBytes: bytes ?? DEFAULT_MCP_IDEMPOTENCY_CONFIG.maxResultBytes,
  };
}

function positiveInteger(name: string, raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export const MCP_IDEMPOTENCY_KEY_PREFIX = 'mcp:idem:';

/** Who is asking, about which call. */
export interface McpIdempotencyScope {
  readonly organizationId: string;
  readonly agentId: string;
  /** The client's key, already validated (`parseIdempotencyKey`). */
  readonly key: string;
  readonly toolId: string;
  /** `argumentsFingerprint(args)`. */
  readonly fingerprint: string;
}

/** The claim an attempt holds while it runs, to complete or release. */
export interface McpIdempotencyHandle {
  readonly redisKey: string;
  /** The exact value written by the claim — compared before any overwrite. */
  readonly claimed: string;
}

export type McpIdempotencyClaim<T> =
  /** This attempt owns the key and runs the call. */
  | { readonly kind: 'CLAIMED'; readonly handle: McpIdempotencyHandle }
  /** An earlier attempt returned a result: answer with it, charge nothing. */
  | { readonly kind: 'REPLAY'; readonly result: T }
  /** An earlier attempt is still running. */
  | { readonly kind: 'IN_PROGRESS'; readonly retryAfterSeconds: number }
  /** The key belongs to another tool or other arguments. */
  | { readonly kind: 'CONFLICT'; readonly reason: 'TOOL' | 'ARGUMENTS' }
  /**
   * Redis did not answer. The call runs without the fast path; a paid call is
   * still guarded by the payment record's unique index.
   */
  | { readonly kind: 'UNAVAILABLE' };

/** What the record holds. Never the arguments: only their hash. */
interface StoredRecord<T> {
  readonly v: 1;
  readonly state: 'IN_FLIGHT' | 'DONE';
  readonly toolId: string;
  readonly fingerprint: string;
  /** Makes each claim's value unique, so a stale attempt cannot touch a newer one. */
  readonly token: string;
  readonly result?: T;
}

/** Delete the key only while it still holds this attempt's claim. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/**
 * Store the result while the key still holds this attempt's claim, or holds
 * nothing (the lease lapsed and nobody claimed it since).
 */
const COMPLETE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false or current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0`;

/**
 * The replay record of a keyed MCP `tools/call` (G2.1), in Redis.
 *
 * ```text
 *   claim     SET mcp:idem:{org}:{agent}:{sha256(key)} IN_FLIGHT NX PX lease
 *     ├─ set            → CLAIMED: run the call
 *     └─ already there  → other tool / other args → CONFLICT
 *                          IN_FLIGHT             → IN_PROGRESS
 *                          DONE                  → REPLAY the stored result
 *   complete  IN_FLIGHT → DONE + result, PX retention window
 *   release   DEL (the call failed with no charge: the key is free again)
 * ```
 *
 * ## Why Redis, and why that is enough
 *
 * The record is short-lived by definition — it exists for one retry window —
 * and a free call has no payment row to hang it on, so the database has no
 * natural home for it. Redis expires it on its own, which is also the privacy
 * answer: the stored output is the provider's response for this agent, kept
 * for at most the retry window and then gone, well inside the evidence-body
 * retention the platform already publishes. Nothing here logs the result or
 * the arguments; a log line names the agent and the key's digest at most.
 *
 * Redis is the fast path, not the guarantee, for money: the paid paths pass
 * the same key to `PaymentIntentService.create`, whose partial unique index
 * keeps one live intent per key even when this record is gone.
 *
 * ## Why the shared cache client
 *
 * A lost record degrades to the payment index (paid) or to running the call
 * again (free); it never spends money twice. That is the
 * `BindingCallCounterService` kind of consumer, so it rides the `@Global`
 * `REDIS_CACHE_CLIENT` rather than opening a connection of its own.
 */
@Injectable()
export class McpIdempotencyStore {
  private readonly logger = new Logger(McpIdempotencyStore.name);

  constructor(
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
    @Inject(MCP_IDEMPOTENCY_CONFIG) private readonly config: McpIdempotencyConfig,
  ) {}

  async claim<T>(scope: McpIdempotencyScope): Promise<McpIdempotencyClaim<T>> {
    const redisKey = redisKeyOf(scope);
    const claimed = JSON.stringify({
      v: 1,
      state: 'IN_FLIGHT',
      toolId: scope.toolId,
      fingerprint: scope.fingerprint,
      token: randomUUID(),
    } satisfies StoredRecord<T>);

    try {
      // Twice at most: a record that expires between the SET and the GET is
      // gone, and the second SET then takes it.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const set = await this.redis.set(
          redisKey,
          claimed,
          'PX',
          this.config.inFlightLeaseMs,
          'NX',
        );
        if (set === 'OK') return { kind: 'CLAIMED', handle: { redisKey, claimed } };

        const raw = await this.redis.get(redisKey);
        if (raw === null) continue;

        const existing = parseRecord<T>(raw);
        if (!existing) {
          // Not ours to interpret. Refusing is safer than overwriting: the
          // agent can retry with a new key.
          return { kind: 'IN_PROGRESS', retryAfterSeconds: this.config.retryAfterSeconds };
        }
        if (existing.toolId !== scope.toolId) return { kind: 'CONFLICT', reason: 'TOOL' };
        if (existing.fingerprint !== scope.fingerprint) {
          return { kind: 'CONFLICT', reason: 'ARGUMENTS' };
        }
        if (existing.state === 'DONE') return { kind: 'REPLAY', result: existing.result as T };
        return { kind: 'IN_PROGRESS', retryAfterSeconds: this.config.retryAfterSeconds };
      }
      return { kind: 'IN_PROGRESS', retryAfterSeconds: this.config.retryAfterSeconds };
    } catch (error) {
      this.logger.warn(
        `agent ${scope.agentId}: idempotency record unreadable, running without the replay ` +
          `fast path. ${describe(error)}`,
      );
      return { kind: 'UNAVAILABLE' };
    }
  }

  /** The call returned a result: keep it for the retry window. Never throws. */
  async complete<T>(handle: McpIdempotencyHandle, result: T): Promise<void> {
    const claimed = parseRecord<T>(handle.claimed) as StoredRecord<T>;
    const done = JSON.stringify({ ...claimed, state: 'DONE', result } satisfies StoredRecord<T>);
    try {
      await this.redis.eval(
        COMPLETE_SCRIPT,
        1,
        handle.redisKey,
        handle.claimed,
        done,
        String(this.config.resultTtlSeconds * 1000),
      );
    } catch (error) {
      // The agent still gets its result; only a retry loses the replay, and a
      // paid retry is still refused a second charge by the payment index.
      this.logger.warn(
        `idempotency result not stored; a retry cannot replay it. ${describe(error)}`,
      );
    }
  }

  /** The call failed with no charge: the key is free for a fresh attempt. Never throws. */
  async release(handle: McpIdempotencyHandle): Promise<void> {
    try {
      await this.redis.eval(RELEASE_SCRIPT, 1, handle.redisKey, handle.claimed);
    } catch (error) {
      this.logger.warn(
        `idempotency claim not released; a retry waits for its lease. ${describe(error)}`,
      );
    }
  }
}

function redisKeyOf(scope: McpIdempotencyScope): string {
  return (
    `${MCP_IDEMPOTENCY_KEY_PREFIX}${scope.organizationId}:${scope.agentId}:` +
    idempotencyKeyDigest(scope.key)
  );
}

function parseRecord<T>(raw: string): StoredRecord<T> | null {
  try {
    const value = JSON.parse(raw) as StoredRecord<T>;
    if (value?.v !== 1 || typeof value.toolId !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
