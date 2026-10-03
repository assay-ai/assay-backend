import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  REDIS_ADAPTER_CLIENT,
  REDIS_ADAPTER_PUB_CLIENT,
  REDIS_ADAPTER_SUB_CLIENT,
} from '@shared/cache/redis-adapter/redis-adapter.provider';
import { SingleFlightOptions } from '@shared/decorators/single-flight.decorator';
import { delay } from '@shared/utils';
import Redis from 'ioredis';

@Injectable()
export class SingleFlightService {
  private readonly logger = new Logger(SingleFlightService.name);
  private leaderPromises = new Map<string, Promise<any>>();
  private waiterPromiseResolvers = new Map<string, (value: any) => void>();
  private waiterPromiseRejects = new Map<string, (value: any) => void>();
  private waiterPromises = new Map<string, Promise<any>>();

  private cleanupChannel(channel: string): void {
    this.leaderPromises.delete(channel);
    this.waiterPromiseResolvers.delete(channel);
    this.waiterPromiseRejects.delete(channel);
    this.waiterPromises.delete(channel);
  }

  constructor(
    @Inject(REDIS_ADAPTER_CLIENT) private readonly redis: Redis,
    @Inject(REDIS_ADAPTER_PUB_CLIENT) private readonly redisPub: Redis,
    @Inject(REDIS_ADAPTER_SUB_CLIENT) private readonly redisSub: Redis,
  ) {
    // ✅ ONE global message handler
    this.redisSub.on('message', async (channel, message) => {
      try {
        let resolve = this.waiterPromiseResolvers.get(channel);
        let reject = this.waiterPromiseRejects.get(channel);

        if (!resolve || !reject) {
          this.logger.warn(`Received message for channel ${channel} but no resolver found 1`);
          await delay(100);
          resolve = this.waiterPromiseResolvers.get(channel);
          reject = this.waiterPromiseRejects.get(channel);
          if (!resolve || !reject) {
            this.logger.warn(`Received message for channel ${channel} but no resolver found 2`);
            return;
          }
        }

        const parsed = JSON.parse(message);

        // Check if this is an error message
        if (parsed && parsed.__error === true) {
          this.logger.log(`Received error message for channel ${channel}`);
          const error = new Error(parsed.message || 'Unknown error');
          if (parsed.stack) {
            error.stack = parsed.stack;
          }
          if (parsed.name) {
            error.name = parsed.name;
          }
          // Copy additional error properties
          Object.assign(error, parsed);
          reject(error);
        } else {
          this.logger.log(`Received success message for channel ${channel}`);
          resolve(parsed);
        }
      } catch (error) {
        this.logger.error(`Failed to parse message for channel ${channel}:`, error);
        // Try to reject if we have a reject handler
        const reject = this.waiterPromiseRejects.get(channel);
        if (reject) {
          reject(error);
        }
      } finally {
        this.cleanupChannel(channel);
        this.redisSub.unsubscribe(channel).catch((err) => {
          this.logger.warn(`Failed to unsubscribe from channel ${channel}:`, err);
        });
      }
    });
  }

  public async execute<T>({
    key,
    fn,
    options,
  }: {
    key: string;
    fn: () => Promise<T>;
    options: SingleFlightOptions;
  }): Promise<T> {
    const cacheKey = `cache:${key}`;
    const lockKey = `lock:${key}`;
    const channel = `sf:result:${key}`;
    const { cache = { setCache: false, cacheTTLInSeconds: 60 }, lock = { lockTTLms: 2000 } } =
      options;

    // Ensure lockTTLms is a valid number
    const lockTTLms = lock.lockTTLms ?? 2000;
    if (!Number.isInteger(lockTTLms) || lockTTLms <= 0) {
      throw new Error(`Invalid lockTTLms: ${lockTTLms}. Must be a positive integer.`);
    }

    // 1️⃣ Check cache first (before any locking)
    if (cache?.setCache) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.log(`Cache hit for key ${key}`);
        return JSON.parse(cached);
      }
    }

    // 2️⃣ Get or create promise atomically (CRITICAL: prevents race condition)
    // Check for existing promise FIRST before creating a new one
    let promise = this.leaderPromises.get(channel);

    if (!promise) {
      // Create promise synchronously BEFORE async operations
      // This ensures other concurrent requests will see it immediately
      promise = this.createExecutionPromise<T>(
        key,
        fn,
        cacheKey,
        lockKey,
        channel,
        cache,
        lockTTLms,
        options,
      );
      // Store promise immediately (synchronously) so other requests can reuse it
      this.leaderPromises.set(channel, promise);
      this.logger.log(`Created new execution promise for key ${key}`);
    } else {
      this.logger.log(`Reusing existing promise for key ${key}`);
    }

    return promise;
  }

  private createExecutionPromise<T>(
    key: string,
    fn: () => Promise<T>,
    cacheKey: string,
    lockKey: string,
    channel: string,
    cache: { setCache: boolean; cacheTTLInSeconds: number },
    lockTTLms: number,
    originalOptions: SingleFlightOptions,
  ): Promise<T> {
    return (async () => {
      // Try to acquire lock (leader election)
      const lockResult = await this.redis.set(lockKey, '1', 'PX', lockTTLms, 'NX');
      const isLeader = lockResult === 'OK';

      if (isLeader) {
        // ✅ We are the leader - execute and publish result
        this.logger.log(`Leader elected for key ${key}`);
        return await this.executeAsLeader(key, fn, cacheKey, channel, cache, lockTTLms);
      }

      try {
        return await this.waitForResult<T>(channel, lockTTLms);
      } catch (error) {
        this.cleanupChannel(channel);
        this.logger.warn(`Timeout waiting for leader result for key ${key}, retrying...`);
        // Leader likely died or timed out → retry & re-elect
        return await this.execute({
          key,
          fn,
          options: originalOptions,
        });
      }
    })();
  }

  private async executeAsLeader<T>(
    key: string,
    fn: () => Promise<T>,
    cacheKey: string,
    channel: string,
    cache: { setCache: boolean; cacheTTLInSeconds: number },
    lockTTLms: number,
  ): Promise<T> {
    const lockKey = `lock:${key}`;

    try {
      // Execute the Promise and get the result
      const result = await fn();

      // Set cache if enabled
      if (cache?.setCache) {
        const cacheTTL = cache.cacheTTLInSeconds;
        if (!Number.isInteger(cacheTTL) || cacheTTL <= 0) {
          this.logger.warn(`Invalid cacheTTLInSeconds: ${cacheTTL}, using default 60`);
          await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 60);
        } else {
          await this.redis.set(cacheKey, JSON.stringify(result), 'EX', cacheTTL);
        }
      }

      await this.redisPub.publish(channel, JSON.stringify(result));
      this.logger.log(`Result published for key ${key}`);
      return result;
    } catch (error) {
      // Publish error to channel so waiters in other instances can receive it
      const errorMessage = {
        __error: true,
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'Error',
        stack: error instanceof Error ? error.stack : undefined,
        // Include additional error properties if it's a custom error
        ...(error instanceof Error && error.constructor !== Error ? error : {}),
      };

      try {
        await this.redisPub.publish(channel, JSON.stringify(errorMessage));
        this.logger.log(`Error published for key ${key}`);
      } catch (publishError) {
        this.logger.error(`Failed to publish error for key ${key}:`, publishError);
      }

      const reject = this.waiterPromiseRejects.get(channel);
      if (reject) {
        reject(error);
      }

      this.cleanupChannel(channel);

      throw error;
    } finally {
      this.cleanupChannel(channel);
      await this.redis.del(lockKey).catch((err) => {
        this.logger.warn(`Failed to delete lock for key ${key}:`, err);
      });
    }
  }

  private async waitForResult<T>(channel: string, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout;
    if (this.waiterPromises.has(channel)) {
      return await this.waiterPromises.get(channel);
    } else {
      const promise = new Promise<T>((resolve, reject) => {
        this.waiterPromiseResolvers.set(channel, resolve);
        this.waiterPromiseRejects.set(channel, reject);

        timer = setTimeout(() => {
          this.cleanupChannel(channel);
          this.redisSub.unsubscribe(channel).catch((err) => {
            this.logger.warn(`Failed to unsubscribe from channel ${channel}:`, err);
          });
          reject(
            new Error(
              `SingleFlight timeout: No result received for channel ${channel} within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      });
      this.waiterPromises.set(channel, promise);

      await this.redisSub.subscribe(channel);
      this.logger.debug(`Subscribed to channel ${channel}`);
      promise.finally(() => {
        if (timer) {
          clearTimeout(timer);
        }
      });
      return promise;
    }
  }
}
