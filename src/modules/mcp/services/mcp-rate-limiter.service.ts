import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { CacheService } from '@shared/cache/redis-cache/cache.service';

/** The MCP host's limits (design spec §7.13), per fixed UTC minute. */
export const MCP_RATE_LIMITS = Object.freeze({
  /** `tools/list`, per credential and URL. */
  listsPerMinute: 60,
  /** Refused `tools/call`s an agent may make before every call is `RATE_LIMITED`. */
  refusalsPerMinute: 60,
  /** Refused calls written to `tool_call_records` per agent; the rest are only counted. */
  refusalRowsPerMinute: 20,
  /** `search_tools`, per agent, across every URL. */
  searchesPerMinute: 30,
  /** `get_tool`, per agent, across every URL. */
  getToolsPerMinute: 120,
});

const WINDOW_MS = 60_000;

/** Injected by tests; production reads the wall clock. */
export const MCP_RATE_CLOCK = 'MCP_RATE_CLOCK';

export interface RateOutcome {
  readonly allowed: boolean;
  /** The calls counted in this window, this one included. */
  readonly count: number;
  readonly retryAfterMs: number;
}

/**
 * Fixed-window counters in Redis, shared by every MCP instance — the same
 * shape as the public demo's limiter, keyed by credential, URL or agent.
 *
 * **Fails open**, unlike the spend lock: these limits protect the server from
 * floods of cheap requests (lists, refusals), and nothing they guard spends
 * money — a call that gets through is still checked by access, the rules and
 * the spend policy. Refusing every list because Redis blinked would take the
 * catalogue down for every agent at once.
 */
@Injectable()
export class McpRateLimiter {
  private readonly logger = new Logger(McpRateLimiter.name);

  constructor(
    @Optional() private readonly cache?: CacheService,
    @Optional() @Inject(MCP_RATE_CLOCK) private readonly now: () => number = Date.now,
  ) {}

  /** Count one more in `key`'s window and say whether it is within `limit`. */
  async take(key: string, limit: number): Promise<RateOutcome> {
    const { bucketKey, retryAfterMs } = this.window(key);
    if (!this.cache) return { allowed: true, count: 0, retryAfterMs };
    try {
      const redis = this.cache.getRedisClient();
      const count = await redis.incr(bucketKey);
      if (count === 1) await redis.pexpire(bucketKey, WINDOW_MS * 2);
      return { allowed: count <= limit, count, retryAfterMs };
    } catch (error) {
      this.logger.warn(`rate counter ${key} unavailable; allowing. ${describe(error)}`);
      return { allowed: true, count: 0, retryAfterMs };
    }
  }

  /** Whether `key`'s window already holds `limit`, without counting. */
  async exceeded(key: string, limit: number): Promise<RateOutcome> {
    const { bucketKey, retryAfterMs } = this.window(key);
    if (!this.cache) return { allowed: true, count: 0, retryAfterMs };
    try {
      const count = Number((await this.cache.getRedisClient().get(bucketKey)) ?? 0);
      return { allowed: count < limit, count, retryAfterMs };
    } catch {
      return { allowed: true, count: 0, retryAfterMs };
    }
  }

  private window(key: string): { bucketKey: string; retryAfterMs: number } {
    const now = this.now();
    const bucket = Math.floor(now / WINDOW_MS);
    return {
      bucketKey: `assay:mcp-rate:${key}:${bucket}`,
      retryAfterMs: Math.max(1, (bucket + 1) * WINDOW_MS - now),
    };
  }
}

/** `tools/list`'s key: the credential and the canonical URL, hashed to a fixed length. */
export function listKey(credentialId: string, canonicalUrl: string): string {
  const url = createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 32);
  return `list:${credentialId}:${url}`;
}

/** An agent's `search_tools` calls. */
export function searchKey(agentId: string): string {
  return `search:${agentId}`;
}

/** An agent's `get_tool` calls. */
export function getToolKey(agentId: string): string {
  return `get-tool:${agentId}`;
}

/** An agent's refused calls. */
export function refusalKey(agentId: string): string {
  return `refusals:${agentId}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
