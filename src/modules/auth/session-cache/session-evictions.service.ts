import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { withRedisTimeout } from '@shared/cache/redis-cache/with-redis-timeout';

import { SessionCache, SessionEvictionTarget } from './session-cache';

export const SESSION_CACHE = 'SESSION_CACHE';
export const SESSION_EVICTIONS_PUBLISHER = 'SESSION_EVICTIONS_PUBLISHER';
export const SESSION_EVICTIONS_SUBSCRIBER = 'SESSION_EVICTIONS_SUBSCRIBER';

/** The channel every process with a session cache listens on. */
export const SESSION_EVICTIONS_CHANNEL = 'assay:session-cache:evict';

/**
 * Evicts cached sessions here and in every other process.
 *
 * Called after the writes a resolved session depends on: a credential or
 * OAuth token revoked, an access epoch bumped, a delegate bound, a wallet
 * linked, an agent renamed. The local cache is evicted synchronously, before
 * the publish, so the process that made the write never serves the old
 * session again; the others hear it over Redis pub/sub. A lost message (Redis
 * down) leaves their entries to expire, at most `SESSION_CACHE_TTL_MS` later.
 *
 * Never throws: an eviction must not fail the write it follows.
 */
@Injectable()
export class SessionEvictions implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionEvictions.name);

  constructor(
    @Inject(SESSION_CACHE) private readonly cache: SessionCache,
    @Inject(SESSION_EVICTIONS_PUBLISHER) private readonly publisher: Redis,
    @Inject(SESSION_EVICTIONS_SUBSCRIBER) private readonly subscriber: Redis,
  ) {}

  onModuleInit(): void {
    this.subscriber.on('message', (channel: string, message: string) => {
      if (channel !== SESSION_EVICTIONS_CHANNEL) return;
      const target = parseTarget(message);
      // An unreadable message clears everything: over-evicting only costs a lookup.
      this.cache.evict(target ?? { all: true });
    });
    // Not awaited: a Redis outage at boot must not hold the process up, and
    // the TTL bounds what a missed message can cost.
    void this.subscriber.subscribe(SESSION_EVICTIONS_CHANNEL).catch((error: unknown) => {
      this.logger.warn(`session evictions not subscribed: ${describe(error)}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber.unsubscribe(SESSION_EVICTIONS_CHANNEL).catch(() => undefined);
    this.subscriber.disconnect();
    this.publisher.disconnect();
  }

  async evict(target: SessionEvictionTarget): Promise<void> {
    this.cache.evict(target);
    try {
      await withRedisTimeout(() =>
        this.publisher.publish(SESSION_EVICTIONS_CHANNEL, JSON.stringify(target)),
      );
    } catch (error) {
      this.logger.warn(
        `session eviction not broadcast; other processes keep it until its TTL: ${describe(error)}`,
      );
    }
  }

  evictOrganization(organizationId: string): Promise<void> {
    return this.evict({ organizationId });
  }
}

function parseTarget(message: string): SessionEvictionTarget | null {
  try {
    const value = JSON.parse(message) as Record<string, unknown>;
    if (typeof value.organizationId === 'string') return { organizationId: value.organizationId };
    if (typeof value.credentialId === 'string') return { credentialId: value.credentialId };
    if (value.all === true) return { all: true };
  } catch {
    // fall through
  }
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
