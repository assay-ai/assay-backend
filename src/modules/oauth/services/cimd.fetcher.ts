import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  OAuthClientEntity,
  OAuthClientKind,
} from '@database/postgres/entities/oauth-client.entity';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { CacheService } from '@shared/cache/redis-cache/cache.service';
import {
  EgressFailureKind,
  EgressHttpClient,
  EgressPolicy,
  INTERNAL_EGRESS_POLICY,
  UNTRUSTED_EGRESS_POLICY,
  isEgressError,
  withLimits,
} from '@shared/network/egress';

import { OAUTH_CONFIG, OAuthConfig } from '../config/oauth.config';
import {
  OAUTH_CIMD_CACHE_DEFAULT_SECONDS,
  OAUTH_CIMD_CACHE_MAX_SECONDS,
  OAUTH_CIMD_CACHE_MIN_SECONDS,
  OAUTH_CIMD_FAILURE_CACHE_SECONDS,
} from '../constants/oauth.constants';
import { classify } from '../domain/client-id';
import { validateClientMetadata } from '../domain/client-metadata';
import { OAuthCimdFetchResult, OAuthMetrics } from './oauth-metrics.service';
import {
  OAUTH_CLOCK,
  OAUTH_MINUTE_SECONDS,
  OAUTH_RATE_LIMITS,
  OAuthRateLimiter,
} from './oauth-rate-limiter.service';

/** §6.3.7: 5 s for the whole fetch, 16 KB of body, no redirect followed. */
export const CIMD_FETCH_LIMITS = Object.freeze({
  headersTimeoutMs: 5000,
  bodyTimeoutMs: 5000,
  totalTimeoutMs: 5000,
  maxResponseBytes: 16_384,
  maxRedirects: 0,
});

/**
 * Public addresses only, `https:` only. `EgressHttpClient` resolves the host
 * once, refuses the request if any answer is non-public (loopback, RFC 1918,
 * link-local and metadata, CGNAT, multicast, IPv4-mapped and other embedded
 * forms, reserved space), and connects to the address it checked, so a second
 * DNS answer cannot redirect the socket.
 */
const CIMD_POLICY: EgressPolicy = Object.freeze({
  ...withLimits(UNTRUSTED_EGRESS_POLICY, CIMD_FETCH_LIMITS),
  allowedProtocols: Object.freeze(['https:']),
});

/**
 * `OAUTH_ALLOW_HTTP_CIMD_LOOPBACK` (e2e only; the boot refuses it in
 * production): a `http://localhost` document is served by the local stack, so
 * the address check is relaxed for that URL alone. Every limit still applies.
 */
const LOOPBACK_CIMD_POLICY: EgressPolicy = Object.freeze({
  ...withLimits(INTERNAL_EGRESS_POLICY, CIMD_FETCH_LIMITS),
  allowedProtocols: Object.freeze(['http:']),
});

const FAILURE_KEY_PREFIX = 'oauth:cimd:fail:';

export type CimdFetchOutcome =
  | { readonly ok: true; readonly client: OAuthClientEntity }
  /** `budget`: not fetched because a budget is spent; nothing is remembered. */
  | { readonly ok: false; readonly reason: 'invalid' | 'budget' };

/**
 * Fetches and caches Client ID Metadata Documents (spec §6.3.7, threat T7).
 *
 * A CIMD `client_id` is a URL a stranger chose, so this is an SSRF surface:
 * the fetch goes through `EgressHttpClient` only (R-OA-9), under the policy
 * above, and is budgeted per host, per client IP key and in total. Clients in
 * `OAUTH_VERIFIED_CLIENTS` are exempt from the budgets (they are pre-warmed
 * at boot), so a flood of unknown clients delays only unknown clients.
 *
 * A good document is stored in `oauth_clients` until `cache_until`; a failed
 * one is remembered in Redis for 60 s. There is no stale-on-error: once
 * `cache_until` passes, a failed re-fetch fails the authorization (credentials
 * already issued are unaffected).
 */
@Injectable()
export class CimdFetcher {
  private readonly logger = new Logger(CimdFetcher.name);
  /** One fetch per URL at a time in this process; joiners share its outcome. */
  private readonly inFlight = new Map<string, Promise<CimdFetchOutcome>>();

  constructor(
    private readonly egress: EgressHttpClient,
    private readonly clients: OAuthClientRepository,
    private readonly limiter: OAuthRateLimiter,
    private readonly cache: CacheService,
    private readonly metrics: OAuthMetrics,
    @Inject(OAUTH_CONFIG) private readonly config: OAuthConfig,
    @Optional() @Inject(OAUTH_CLOCK) private readonly now: () => number = Date.now,
  ) {}

  /** The client document at `url`, from the cache or fetched now for `ipKey`. */
  async fetch(url: string, ipKey: string): Promise<CimdFetchOutcome> {
    const options = {
      mcpPublicUrl: this.config.issuer,
      allowHttpLoopback: this.config.allowHttpCimdLoopback,
    };
    if (classify(url, options).kind !== 'CIMD') return { ok: false, reason: 'invalid' };

    const cached = await this.clients.findByClientId(url);
    if (
      cached?.kind === OAuthClientKind.CIMD &&
      cached.cacheUntil &&
      cached.cacheUntil.getTime() > this.now()
    ) {
      return { ok: true, client: cached };
    }

    const running = this.inFlight.get(url);
    if (running) return running;
    const work = this.refresh(url, ipKey).finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, work);
    return work;
  }

  private async refresh(url: string, ipKey: string): Promise<CimdFetchOutcome> {
    if (await this.failedRecently(url)) return { ok: false, reason: 'invalid' };

    if (!this.isVerified(url) && !(await this.withinBudgets(url, ipKey))) {
      this.metrics.incCimdFetch('budget');
      return { ok: false, reason: 'budget' };
    }

    const outcome = await this.fetchDocument(url);
    this.metrics.incCimdFetch(outcome.result);
    if (outcome.result !== 'ok') {
      await this.rememberFailure(url);
      return { ok: false, reason: 'invalid' };
    }

    const now = this.now();
    const client = await this.clients.upsertByClientId({
      clientId: url,
      kind: OAuthClientKind.CIMD,
      clientName: outcome.document.clientName,
      clientUri: outcome.document.clientUri,
      redirectUris: outcome.document.redirectUris,
      metadata: outcome.document.metadata,
      fetchedAt: new Date(now),
      cacheUntil: new Date(now + outcome.maxAgeSeconds * 1000),
    });
    // The URL is held by a client of another kind: never turn it into a CIMD client.
    if (!client) return { ok: false, reason: 'invalid' };
    return { ok: true, client };
  }

  private async fetchDocument(url: string): Promise<
    | {
        result: 'ok';
        document: NonNullable<ReturnType<typeof validDocument>>;
        maxAgeSeconds: number;
      }
    | { result: Exclude<OAuthCimdFetchResult, 'ok' | 'budget'> }
  > {
    const policy = url.startsWith('http://') ? LOOPBACK_CIMD_POLICY : CIMD_POLICY;
    let response;
    try {
      response = await this.egress.request({
        url,
        method: 'GET',
        headers: { accept: 'application/json' },
        policy,
      });
    } catch (error) {
      const result = egressResult(error);
      // The URL is not a secret; the address it resolved to stays in the egress log.
      this.logger.warn(`CIMD fetch of ${url} failed: ${result}`);
      return { result };
    }

    if (response.status !== 200) return { result: 'status' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return { result: 'invalid' };
    }
    const document = validDocument(parsed, url, this.config);
    if (!document) return { result: 'invalid' };
    return {
      result: 'ok',
      document,
      maxAgeSeconds: cacheSeconds(response.headers['cache-control']),
    };
  }

  private isVerified(url: string): boolean {
    return this.config.verifiedClients.some((client) => client.clientId === url);
  }

  /** Per IP key, then per host, then the total; any refusal (or Redis down) stops the fetch. */
  private async withinBudgets(url: string, ipKey: string): Promise<boolean> {
    const host = new URL(url).hostname;
    const minute = OAUTH_MINUTE_SECONDS;
    return (
      (await this.limiter.take('cimd-ip', ipKey, OAUTH_RATE_LIMITS.cimdPerIpPerMinute, minute)) &&
      (await this.limiter.take(
        'cimd-host',
        host,
        OAUTH_RATE_LIMITS.cimdPerHostPerMinute,
        minute,
      )) &&
      (await this.limiter.take('cimd-all', 'all', OAUTH_RATE_LIMITS.cimdGlobalPerMinute, minute))
    );
  }

  private async failedRecently(url: string): Promise<boolean> {
    try {
      return (await this.cache.getRedisClient().get(failureKey(url))) !== null;
    } catch {
      // Unreadable: the budgets (which fail closed) still bound the fetches.
      return false;
    }
  }

  private async rememberFailure(url: string): Promise<void> {
    try {
      await this.cache
        .getRedisClient()
        .set(failureKey(url), '1', 'EX', OAUTH_CIMD_FAILURE_CACHE_SECONDS);
    } catch (error) {
      this.logger.warn(
        `could not remember a CIMD failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function failureKey(url: string): string {
  return FAILURE_KEY_PREFIX + createHash('sha256').update(url).digest('hex');
}

/** The document's client metadata, when it is valid for `url` (§6.3.7). */
function validDocument(parsed: unknown, url: string, config: OAuthConfig) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  // Byte for byte: no normalisation of either side.
  if ((parsed as Record<string, unknown>).client_id !== url) return null;
  const checked = validateClientMetadata(parsed, config.redirectAllowlist);
  return checked.ok ? checked.value : null;
}

/** `max-age` clamped to [300, 86 400] s; 3600 s when absent or unreadable. */
export function cacheSeconds(cacheControl: string | undefined): number {
  const match = /(?:^|[,\s])max-age\s*=\s*"?(\d{1,10})"?(?:$|[,\s;])/i.exec(cacheControl ?? '');
  const seconds = match ? Number(match[1]) : OAUTH_CIMD_CACHE_DEFAULT_SECONDS;
  return Math.min(OAUTH_CIMD_CACHE_MAX_SECONDS, Math.max(OAUTH_CIMD_CACHE_MIN_SECONDS, seconds));
}

/** The metric label for a refused or failed fetch. */
function egressResult(error: unknown): Exclude<OAuthCimdFetchResult, 'ok' | 'budget'> {
  if (!isEgressError(error)) return 'status';
  switch (error.kind) {
    case EgressFailureKind.BLOCKED_ADDRESS:
      return 'blocked_address';
    case EgressFailureKind.TIMEOUT:
      return 'timeout';
    case EgressFailureKind.RESPONSE_TOO_LARGE:
      return 'too_large';
    case EgressFailureKind.URL_INVALID:
    case EgressFailureKind.SCHEME_NOT_ALLOWED:
      return 'invalid';
    default:
      // A 3xx (never followed), DNS failure, refused or reset connection.
      return 'status';
  }
}
