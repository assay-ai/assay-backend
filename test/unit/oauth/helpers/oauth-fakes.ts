import { randomUUID } from 'node:crypto';

import { OAuthClientEntity } from '@database/postgres/entities/oauth-client.entity';
import { OAuthClientUpsert } from '@database/postgres/repositories/oauth-client.repository';
import { OAuthConfig } from '@modules/oauth/config/oauth.config';
import { OAuthMetrics } from '@modules/oauth/services/oauth-metrics.service';
import { OAuthRateLimiter } from '@modules/oauth/services/oauth-rate-limiter.service';
import { MetricsRegistryService } from '@modules/observability/services/metrics-registry.service';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

/**
 * The Redis commands the OAuth services use: `INCR`, `PEXPIRE`, `GET`,
 * `SET … EX`, `DEL`. Expiries are recorded, not enforced; a test moves the
 * clock or calls `expire(key)` itself.
 */
export class FakeOAuthRedis {
  readonly strings = new Map<string, string>();
  readonly expiries = new Map<string, number>();
  down = false;

  private guard(): void {
    if (this.down) throw new Error('redis is unreachable');
  }

  incr(key: string): Promise<number> {
    try {
      this.guard();
    } catch (error) {
      return Promise.reject(error);
    }
    const next = Number(this.strings.get(key) ?? '0') + 1;
    this.strings.set(key, String(next));
    return Promise.resolve(next);
  }

  pexpire(key: string, ms: number): Promise<number> {
    this.expiries.set(key, ms);
    return Promise.resolve(1);
  }

  get(key: string): Promise<string | null> {
    try {
      this.guard();
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(this.strings.get(key) ?? null);
  }

  set(key: string, value: string, _ex: 'EX', seconds: number): Promise<'OK'> {
    try {
      this.guard();
    } catch (error) {
      return Promise.reject(error);
    }
    this.strings.set(key, value);
    this.expiries.set(key, seconds * 1000);
    return Promise.resolve('OK');
  }

  del(key: string): Promise<number> {
    const had = this.strings.delete(key);
    this.expiries.delete(key);
    return Promise.resolve(had ? 1 : 0);
  }

  /** Forget a key, as Redis does when its expiry passes. */
  expire(key: string): void {
    this.strings.delete(key);
    this.expiries.delete(key);
  }

  keys(prefix: string): string[] {
    return [...this.strings.keys()].filter((key) => key.startsWith(prefix));
  }
}

export function fakeCache(redis: FakeOAuthRedis): CacheService {
  return { getRedisClient: () => redis } as unknown as CacheService;
}

/** An in-memory `OAuthClientRepository`: the two methods the registry uses. */
export class FakeOAuthClientRepository {
  readonly rows = new Map<string, OAuthClientEntity>();
  upserts = 0;

  findByClientId(clientId: string): Promise<OAuthClientEntity | null> {
    return Promise.resolve(this.rows.get(clientId) ?? null);
  }

  insertClient(values: OAuthClientUpsert): Promise<OAuthClientEntity> {
    if (this.rows.has(values.clientId)) return Promise.reject(new Error('duplicate client_id'));
    return this.upsertByClientId(values);
  }

  upsertByClientId(values: OAuthClientUpsert): Promise<OAuthClientEntity> {
    this.upserts += 1;
    const existing = this.rows.get(values.clientId);
    const now = new Date();
    const row = Object.assign(new OAuthClientEntity(), {
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
      lastUsedAt: existing?.lastUsedAt ?? null,
      ...values,
    });
    this.rows.set(values.clientId, row);
    return Promise.resolve(row);
  }
}

export const MCP = 'https://mcp.assay.ai';
export const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

export function oauthConfig(overrides: Partial<OAuthConfig> = {}): OAuthConfig {
  return {
    issuer: MCP,
    webAppUrl: 'https://app.assay.ai',
    verifiedClients: [],
    redirectAllowlist: [
      { uri: CHATGPT_REDIRECT, review: false },
      { uri: 'https://claude.ai/api/mcp/auth_callback', review: true },
    ],
    paymentClients: [`${MCP}/oauth/clients/assay-mcp`],
    allowHttpCimdLoopback: false,
    requestCookieSecret: Buffer.alloc(32, 7),
    ...overrides,
  };
}

/** Real metrics on a fresh registry, so a test can read a counter back. */
export function oauthMetrics(): { metrics: OAuthMetrics; registry: MetricsRegistryService } {
  const registry = new MetricsRegistryService();
  return { metrics: new OAuthMetrics(registry), registry };
}

export async function counterValue(
  registry: MetricsRegistryService,
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const metric = await registry.registry.getSingleMetric(name)?.get();
  const value = metric?.values.find((entry) =>
    Object.entries(labels).every(([key, want]) => entry.labels[key] === want),
  );
  return value?.value ?? 0;
}

export class Clock {
  constructor(public ms = Date.parse('2026-10-19T12:00:30Z')) {}
  readonly now = (): number => this.ms;
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

export function rateLimiter(redis: FakeOAuthRedis, clock: Clock): OAuthRateLimiter {
  return new OAuthRateLimiter(fakeCache(redis), clock.now);
}
