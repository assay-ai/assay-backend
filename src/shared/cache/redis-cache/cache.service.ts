import { Injectable, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CACHE_CLIENT } from './redis-cache.provider';

@Injectable()
export class CacheService {
  constructor(@Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key);
    if (!value) return null;

    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);

    if (ttl) {
      await this.redis.setex(key, ttl, serialized);
    } else {
      await this.redis.set(key, serialized);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async delPattern(pattern: string): Promise<void> {
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  async reset(): Promise<void> {
    await this.redis.flushdb();
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.redis.exists(key);
    return result === 1;
  }

  async ttl(key: string): Promise<number> {
    return await this.redis.ttl(key);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.redis.expire(key, seconds);
  }

  // Low-level methods for advanced use cases (e.g., SWR cache)
  /**
   * Get raw string value without JSON parsing
   */
  async getRaw(key: string): Promise<string | null> {
    return await this.redis.get(key);
  }

  /**
   * Set raw string value without JSON stringification
   */
  async setRaw(key: string, value: string): Promise<void> {
    await this.redis.set(key, value);
  }

  /**
   * Set raw string value with TTL (in seconds)
   * Used by SWR cache provider to apply hard expiration on keys.
   */
  async setRawWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds > 0) {
      await this.redis.setex(key, ttlSeconds, value);
    } else {
      await this.redis.set(key, value);
    }
  }

  /**
   * Set with advanced options (for distributed locking, etc.)
   * @param key - Cache key
   * @param value - Value to set
   * @param options - Redis SET options (PX for milliseconds TTL, NX for only-if-not-exists, etc.)
   * @returns Result of SET command (e.g., 'OK' or null for NX when key exists)
   */
  async setWithOptions(
    key: string,
    value: string,
    ...options: (string | number)[]
  ): Promise<string | null> {
    return (await this.redis.set(key, value, ...(options as any))) as string | null;
  }

  /**
   * Delete multiple keys at once
   */
  async delMultiple(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.redis.del(...keys);
  }

  /**
   * Scan keys with pattern (for efficient key iteration)
   * @param cursor - Cursor for pagination (start with '0')
   * @param pattern - Pattern to match (e.g., 'prefix:*')
   * @param count - Approximate number of keys to return per iteration
   * @returns Tuple of [newCursor, keys]
   */
  async scan(cursor: string, pattern: string, count = 100): Promise<[string, string[]]> {
    return await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
  }

  /**
   * Get the underlying Redis client (for advanced operations)
   * Use with caution - prefer using CacheService methods when possible
   */
  getRedisClient(): Redis {
    return this.redis;
  }
}
