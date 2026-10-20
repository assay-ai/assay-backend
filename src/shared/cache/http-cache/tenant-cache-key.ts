import { createHash } from 'node:crypto';

import { OPERATOR_REQUEST_KEY } from '@shared/auth/operator-request.key';
import { SESSION_REQUEST_KEY } from '@shared/auth/session-request.key';
import type { TenantCacheVary } from '@shared/decorators/tenant-cache.decorator';

interface SessionShape {
  organizationId?: unknown;
  agentId?: unknown;
  agentAccount?: unknown;
  chainId?: unknown;
  credentialId?: unknown;
  callerKind?: unknown;
  delegateAccount?: unknown;
  paymentsAllowed?: unknown;
  blocked?: unknown;
}

export interface TenantCacheCaller {
  /** The organization whose epochs key the entry; `null` for `operator`. */
  organizationId: string | null;
  /** Everything about the caller the body may depend on, per `vary`. */
  fingerprint: string;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Who a tenant-cached entry belongs to, or `null` when the caller cannot be
 * attributed — the request is then not cached at all (fail closed, as
 * `readCacheTenant`).
 *
 * The caller kind and the block state are in every per-tenant fingerprint:
 * a handler may branch on either (a person-only include, a blocked banner),
 * so a person's entry must never answer an agent token, nor an unblocked
 * session's a blocked one.
 */
export function tenantCacheCaller(
  request: unknown,
  vary: TenantCacheVary,
): TenantCacheCaller | null {
  const req = request as Record<string, unknown> | null;
  if (vary === 'operator') {
    // Only after `OperatorAuthGuard` attached a session: an operator route
    // reached any other way is not cached.
    const operator = req?.[OPERATOR_REQUEST_KEY] as { operatorId?: unknown } | undefined;
    if (!text(operator?.operatorId)) return null;
    return { organizationId: null, fingerprint: 'operator' };
  }

  const session = req?.[SESSION_REQUEST_KEY] as SessionShape | undefined;
  const organizationId = text(session?.organizationId);
  const callerKind = text(session?.callerKind);
  if (!organizationId || !callerKind) return null;

  const parts: Array<[string, unknown]> = [
    ['o', organizationId],
    ['k', callerKind],
    ['b', session?.blocked ? JSON.stringify(session.blocked) : ''],
  ];
  if (vary === 'agent' || vary === 'credential') {
    const agentId = text(session?.agentId);
    if (!agentId) return null;
    parts.push(
      ['a', agentId],
      ['acct', session?.agentAccount ?? ''],
      ['chain', session?.chainId ?? ''],
      ['d', session?.delegateAccount ?? ''],
      ['p', session?.paymentsAllowed === true ? '1' : '0'],
    );
  }
  if (vary === 'credential') {
    const credentialId = text(session?.credentialId);
    if (!credentialId) return null;
    parts.push(['c', credentialId]);
  }
  return { organizationId, fingerprint: JSON.stringify(parts) };
}

/** Query parameters in a stable order, nested values included. */
export function normalizedQuery(query: unknown): string {
  return stableStringify(query ?? {});
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as any)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The Redis key of one tenant-cached response. */
export function tenantCacheKey(input: {
  path: string;
  query: unknown;
  caller: TenantCacheCaller;
  epochs: readonly string[];
  scopes: readonly string[];
}): string {
  const material = [
    input.path,
    normalizedQuery(input.query),
    input.caller.fingerprint,
    input.scopes.map((scope, i) => `${scope}=${input.epochs[i]}`).join('&'),
  ].join('\n');
  return `http-cache:tenant:${createHash('sha256').update(material).digest('hex')}`;
}

/**
 * The weak validator of one entry: its key (and so its epochs) and its body.
 *
 * Weak because Cloudflare turns a strong `ETag` weak when it compresses a
 * response, and Express compares `If-None-Match` weakly anyway.
 */
export function tenantCacheEtag(key: string, body: unknown): string {
  const digest = createHash('sha256')
    .update(key)
    .update('\n')
    .update(JSON.stringify(body) ?? '')
    .digest('base64url')
    .slice(0, 27);
  return `W/"tc-${digest}"`;
}
