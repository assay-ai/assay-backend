import { createHash } from 'node:crypto';

import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

import { chainMetadata } from '@modules/chains/chain-metadata';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { registeredAssets } from '@modules/chains/ports/asset-registry';
import { ChainId } from '@modules/chains/ports/caip.types';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { withRedisTimeout } from '@shared/cache/redis-cache/with-redis-timeout';

import { ANALYTICS_CACHE_MS, analyticsWindow } from '../domain/analytics-window';
import {
  ProtocolAnalyticsQueryDto,
  ProtocolAnalyticsResponseDto,
} from '../dto/protocol-analytics.dto';
import { ProtocolAnalyticsRepository } from '@database/postgres/repositories/protocol-analytics.repository';

@Injectable()
export class ProtocolAnalyticsService {
  private readonly configKey: string;
  private readonly inFlight = new Map<string, Promise<ProtocolAnalyticsResponseDto>>();

  constructor(
    private readonly repository: ProtocolAnalyticsRepository,
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
    @Inject(ENABLED_CHAINS) private readonly chains: readonly ChainId[],
  ) {
    this.configKey = createHash('sha256').update(JSON.stringify(chains)).digest('hex');
  }

  read(query: ProtocolAnalyticsQueryDto): Promise<ProtocolAnalyticsResponseDto> {
    const range = query.range ?? '30d';
    // Bound query/cardinality even when called outside the HTTP validation pipe.
    if (!['7d', '30d', '90d', 'all'].includes(range))
      throw new BadRequestException('Invalid analytics range');
    const assets = registeredAssets()
      .filter((asset) => this.chains.includes(asset.chainId))
      .map((asset) => ({
        id: asset.assetId,
        chainId: asset.chainId,
        chainName: chainMetadata(asset.chainId).displayName,
        symbol: asset.symbol,
        decimals: asset.decimals,
      }));
    const asset = query.asset ? assets.find((item) => item.id === query.asset) : assets[0];
    if (query.asset && !asset) throw new BadRequestException('Asset is not enabled for analytics');
    const key = `protocol-analytics:v2:${this.configKey}:${range}:${asset?.id ?? 'none'}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = this.load(key, range, assets, asset ?? null).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, pending);
    return pending;
  }

  private async load(
    key: string,
    range: ProtocolAnalyticsResponseDto['range'],
    assets: ProtocolAnalyticsResponseDto['assets'],
    asset: ProtocolAnalyticsResponseDto['asset'],
  ): Promise<ProtocolAnalyticsResponseDto> {
    try {
      const raw = await withRedisTimeout(() => this.redis.get(key), 150);
      if (raw && raw.length < 1_000_000) {
        const cached = JSON.parse(raw) as ProtocolAnalyticsResponseDto;
        const age = Date.now() - Date.parse(cached.generatedAt);
        if (
          age >= 0 &&
          age < ANALYTICS_CACHE_MS &&
          cached.range === range &&
          cached.asset?.id === asset?.id &&
          Array.isArray(cached.daily) &&
          Array.isArray(cached.topTools) &&
          Array.isArray(cached.recent) &&
          cached.state === 'OK'
        )
          return cached;
      }
    } catch {
      /* A cache outage or invalid entry must not turn missing data into zero. */
    }

    const now = new Date();
    const base = {
      generatedAt: now.toISOString(),
      cacheTtlMs: ANALYTICS_CACHE_MS,
      assets,
      asset,
      range,
    };
    if (!asset)
      return {
        ...base,
        state: 'UNAVAILABLE',
        window: null,
        totals: null,
        previous: null,
        daily: [],
        topTools: [],
        recent: [],
        escrow: null,
        withheldForPrivacy: false,
      };
    const window = analyticsWindow(range, now);
    // Database errors propagate as errors, not zero-valued success responses.
    const snapshot = await this.repository.read(asset.id, window, asset.decimals);
    const { from, ...snapshotData } = snapshot;
    const result: ProtocolAnalyticsResponseDto = {
      ...base,
      ...snapshotData,
      state: 'OK',
      window: {
        from: window.from?.toISOString() ?? from,
        to: now.toISOString(),
        chartFrom: window.chartFrom.toISOString(),
      },
    };
    // Expire against snapshot time, including database latency; never renew an old snapshot.
    const remaining = ANALYTICS_CACHE_MS - (Date.now() - now.getTime());
    if (remaining > 0) {
      try {
        await withRedisTimeout(
          () => this.redis.set(key, JSON.stringify(result), 'PX', remaining),
          150,
        );
      } catch {
        /* Redis is an optional acceleration layer. */
      }
    }
    return result;
  }
}
