import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

const SESSION_PREFIX = 'operator:session:';
const BY_OPERATOR_PREFIX = 'operator:sessions-of:';

export interface StoredOperatorSession {
  readonly operatorId: string;
  readonly expiresAt: string;
}

/** SHA-256 hex of a session token. The token itself is never stored. */
export function digestSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Operator sessions, in Redis.
 *
 * A session is an opaque random token (32 bytes, base64url) returned once at
 * sign-in. Redis holds only its SHA-256, with the operator id and expiry, under
 * a TTL equal to the session's life — so an expired session is simply gone.
 * Each operator also has a set of their session digests, so removing or
 * suspending them can revoke every session at once on every instance.
 *
 * Fails closed: a Redis error while resolving a token is an error, never an
 * "allowed".
 */
@Injectable()
export class OperatorSessionStore {
  constructor(@Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis) {}

  async issue(operatorId: string, ttlSeconds: number): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const digest = digestSessionToken(token);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const record: StoredOperatorSession = { operatorId, expiresAt: expiresAt.toISOString() };
    const index = BY_OPERATOR_PREFIX + operatorId;
    await this.redis
      .multi()
      .set(SESSION_PREFIX + digest, JSON.stringify(record), 'EX', ttlSeconds)
      .sadd(index, digest)
      .expire(index, ttlSeconds)
      .exec();
    return { token, expiresAt };
  }

  async find(token: string): Promise<StoredOperatorSession | null> {
    const raw = await this.redis.get(SESSION_PREFIX + digestSessionToken(token));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredOperatorSession;
      if (typeof parsed?.operatorId !== 'string') return null;
      if (Date.parse(parsed.expiresAt) <= Date.now()) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Revoke one session. Idempotent. Returns its operator, when it was live. */
  async revoke(token: string): Promise<string | null> {
    const digest = digestSessionToken(token);
    const raw = await this.redis.get(SESSION_PREFIX + digest);
    await this.redis.del(SESSION_PREFIX + digest);
    if (!raw) return null;
    try {
      const { operatorId } = JSON.parse(raw) as StoredOperatorSession;
      await this.redis.srem(BY_OPERATOR_PREFIX + operatorId, digest);
      return operatorId;
    } catch {
      // The session is gone either way; the index entry expires with its TTL.
      return null;
    }
  }

  /** Revoke every session of one operator. */
  async revokeAll(operatorId: string): Promise<void> {
    const index = BY_OPERATOR_PREFIX + operatorId;
    const digests = await this.redis.smembers(index);
    const keys = digests.map((digest) => SESSION_PREFIX + digest);
    await this.redis.del(index, ...keys);
  }
}
