import { SetMetadata } from '@nestjs/common';

import type { TenantEpochScope } from '@shared/cache/redis-cache/tenant-epoch.service';

export const TENANT_CACHE_KEY = 'tenant_cache';

/**
 * Whose answer a cached response is.
 *
 * - `org`: every caller of the organization gets the same body (the handler
 *   reads only `session.organizationId`). Still split by caller kind and block
 *   state, so a person's entry never answers an agent token.
 * - `agent`: the body depends on the calling agent (its account, delegate,
 *   spend policy, debts).
 * - `credential`: the body depends on the credential itself.
 * - `operator`: one entry for every operator; only for a response that does
 *   not embed the viewer's identity or depend on their roles beyond the guard.
 */
export type TenantCacheVary = 'org' | 'agent' | 'credential' | 'operator';

export interface TenantCacheOptions {
  /** Seconds. Money display reads stay at 5 s or less. */
  ttl: number;
  vary: TenantCacheVary;
  /** The epochs the body depends on; a bump of any of them is a miss. */
  epochs: readonly TenantEpochScope[];
  /** Coalesce concurrent misses for one key into one handler run. */
  singleFlight?: boolean;
}

/**
 * Cache a signed-in GET in Redis, per tenant, invalidated by epoch.
 *
 * Read by `HttpCacheInterceptor`. The key is the path, the normalized query,
 * the caller (per `vary`) and the current value of every epoch in `epochs`.
 * Every response carries a weak `ETag` naming the cached entry, so a poll that
 * sends `If-None-Match` while the entry lives is answered `304` from Redis
 * without the handler running.
 *
 * Only for **display** reads. Nothing that decides money — a seq, an intent,
 * a voucher, a signature, an admission — may carry it, and neither may a
 * route that sets its own headers or status, streams, or returns a secret.
 */
export const TenantCache = (options: TenantCacheOptions) => SetMetadata(TENANT_CACHE_KEY, options);
