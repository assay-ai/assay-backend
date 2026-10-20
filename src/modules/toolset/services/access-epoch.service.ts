import { Injectable, Logger } from '@nestjs/common';

import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { readEpoch } from '@shared/cache/redis-cache/epoch-counter';

/**
 * One counter per organization that every cached access or MCP view of that
 * organization is keyed on (NFR-1).
 *
 * A write to a spend policy's access, a key's narrowing or a toolset's Draft
 * bumps it, and every MCP instance sees the new value on its next request:
 * invalidation is immediate and cross-instance without a broadcast. The 60 s
 * TTL on the cached values is only a backstop.
 *
 * A missing key is created from the clock, never read as a constant, so an
 * evicted counter cannot make old entries match again (`readEpoch`).
 *
 * Fails safe both ways: an unreadable counter reads as "no cache", so the
 * value is recomputed rather than served stale; a failed bump is logged and
 * the TTL bounds the staleness.
 */
@Injectable()
export class AccessEpochService {
  private readonly logger = new Logger(AccessEpochService.name);

  constructor(private readonly cache: CacheService) {}

  /** The organization's current epoch, or `null` when it cannot be read. */
  async current(organizationId: string): Promise<string | null> {
    try {
      return await readEpoch(this.cache.getRedisClient(), epochKey(organizationId));
    } catch {
      return null;
    }
  }

  /**
   * The organization's epoch combined with the sharing epoch: what a cached
   * access or view that may read another organization's shared toolset is
   * keyed on. `null` when either cannot be read.
   */
  async currentWithSharing(organizationId: string): Promise<string | null> {
    const [own, shared] = await Promise.all([this.current(organizationId), this.currentShared()]);
    return own === null || shared === null ? null : `${own}:${shared}`;
  }

  /**
   * One counter for everything shared across organizations: a publish, a
   * share-state change, a takedown, a handle change. Rare writes, so one
   * global counter is enough, and a shared URL's view is cached once for
   * every organization against it.
   */
  async currentShared(): Promise<string | null> {
    try {
      return await readEpoch(this.cache.getRedisClient(), SHARED_EPOCH_KEY);
    } catch {
      return null;
    }
  }

  async bumpShared(): Promise<void> {
    try {
      await this.cache.getRedisClient().incr(SHARED_EPOCH_KEY);
    } catch (error) {
      this.logger.warn(
        'sharing epoch not bumped; cached shared views last until their TTL. ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  async bump(organizationId: string): Promise<void> {
    try {
      await this.cache.getRedisClient().incr(epochKey(organizationId));
    } catch (error) {
      this.logger.warn(
        `org ${organizationId}: access epoch not bumped; cached access lasts until its TTL. ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

export const SHARED_EPOCH_KEY = 'assay:access-epoch:shared';

export function epochKey(organizationId: string): string {
  return `assay:access-epoch:${organizationId}`;
}
