import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import { OAUTH_PENDING_REQUEST_TTL_SECONDS } from '../constants/oauth.constants';
import { BIND_SCRIPT, DECIDE_SCRIPT, TAKE_SCRIPT } from './oauth-request.lua';
import { OAuthCodeApproval, OAuthCodeRequest } from './oauth-token.service';

/**
 * A pending authorization request (spec §6.3.4 step 3), as `/oauth/authorize`
 * stores it, the consent API reads and decides it, and
 * `/oauth/authorize/continue` takes it.
 *
 * The field names are those of {@link OAuthCodeRequest} and
 * {@link OAuthCodeApproval}, so a taken, approved request is passed to
 * `OAuthTokenService.mintCode` as it is.
 */
export interface OAuthPendingRequest extends OAuthCodeRequest {
  /** The client's `state`, returned to it unchanged; `null` when it sent none. */
  readonly state: string | null;
  /** Built-in client only: the display-only device label (`assay_device`), already sanitised. */
  readonly device: string | null;
  /** Built-in client only: the credential id the profile held before (`assay_replaces`). */
  readonly replaces: string | null;
  /** ISO-8601, when `/oauth/authorize` stored it. */
  readonly createdAt: string;
  /** Set once, by approval. */
  readonly approval: OAuthCodeApproval | null;
  /** Set once, by denial. */
  readonly denied: boolean;
}

/** What `/oauth/authorize` supplies; the rest is the store's. */
export type NewOAuthPendingRequest = Omit<
  OAuthPendingRequest,
  'createdAt' | 'boundOrganizationId' | 'approval' | 'denied'
>;

export type BindResult =
  | { readonly status: 'ok'; readonly request: OAuthPendingRequest }
  | { readonly status: 'not_found' | 'already_decided' };

export type DecideResult = 'ok' | 'not_found' | 'already_decided';

/** `'deny'`, or the approval to record. */
export type OAuthDecision = OAuthCodeApproval | 'deny';

export const OAUTH_REQUEST_KEY_PREFIX = 'oauth:req:';
export const OAUTH_REQUEST_DONE_KEY_PREFIX = 'oauth:req-done:';

/** 32 random bytes, base64url: 43 characters. */
const RID_RE = /^[A-Za-z0-9_-]{43}$/;

/** Whether `rid` has the shape {@link OAuthRequestStore.create} gives one. */
export function isWellFormedRid(rid: unknown): rid is string {
  return typeof rid === 'string' && RID_RE.test(rid);
}

/**
 * Pending authorization requests in Redis (spec §6.2, §6.3.5):
 * `oauth:req:{rid}` for 600 s, and the tombstone `oauth:req-done:{rid}` for
 * 600 s once it is decided.
 *
 * - {@link create}: a new request; `rid` is 32 random bytes, base64url.
 * - {@link bind}: the first organization to read a request owns it; any
 *   other organization gets `not_found` from then on.
 * - {@link decide}: approve or deny, once, atomically; writes the tombstone.
 * - {@link take}: `GETDEL`, for `continue` in the browser that started it.
 *
 * `rid` is a bearer secret until the request is taken: whoever holds it (and
 * a human session) can bind the request. It is never logged, never put in an
 * error, and a malformed one never reaches Redis (R-OA-27).
 */
@Injectable()
export class OAuthRequestStore {
  constructor(@Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis) {}

  async create(input: NewOAuthPendingRequest): Promise<string> {
    const rid = randomBytes(32).toString('base64url');
    const request: OAuthPendingRequest = {
      oauthClientId: input.oauthClientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scope: input.scope,
      state: input.state,
      device: input.device,
      replaces: input.replaces,
      createdAt: new Date().toISOString(),
      boundOrganizationId: null,
      approval: null,
      denied: false,
    };
    const stored = await this.redis.set(
      requestKey(rid),
      JSON.stringify(request),
      'EX',
      OAUTH_PENDING_REQUEST_TTL_SECONDS,
      'NX',
    );
    // 256 random bits do not collide; if they ever did, fail rather than overwrite.
    if (stored !== 'OK') throw new Error('pending OAuth request not stored');
    return rid;
  }

  /** Binds the request to `organizationId` if it is unbound, and returns it. */
  async bind(rid: string, organizationId: string): Promise<BindResult> {
    if (!isWellFormedRid(rid)) return { status: 'not_found' };
    const result = (await this.redis.eval(
      BIND_SCRIPT,
      2,
      requestKey(rid),
      doneKey(rid),
      organizationId,
    )) as [string, string?];
    if (result[0] === 'ok' && typeof result[1] === 'string') {
      return { status: 'ok', request: parse(result[1]) };
    }
    return { status: result[0] === 'already_decided' ? 'already_decided' : 'not_found' };
  }

  /**
   * Records `decision` once. Binds the request to `organizationId` if no one
   * has read it yet; another organization's request is `not_found`.
   */
  async decide(
    rid: string,
    organizationId: string,
    decision: OAuthDecision,
  ): Promise<DecideResult> {
    if (!isWellFormedRid(rid)) return 'not_found';
    const approval =
      decision === 'deny'
        ? ''
        : JSON.stringify({
            agentId: decision.agentId,
            name: decision.name,
            approvedBy: decision.approvedBy,
            replaces: decision.replaces,
          } satisfies OAuthCodeApproval);
    const result = (await this.redis.eval(
      DECIDE_SCRIPT,
      2,
      requestKey(rid),
      doneKey(rid),
      organizationId,
      approval,
      String(OAUTH_PENDING_REQUEST_TTL_SECONDS),
    )) as string;
    return result === 'ok' || result === 'already_decided' ? result : 'not_found';
  }

  /** Reads and deletes the request in one step. `null` if it is gone or was never there. */
  async take(rid: string): Promise<OAuthPendingRequest | null> {
    if (!isWellFormedRid(rid)) return null;
    const raw = (await this.redis.eval(TAKE_SCRIPT, 1, requestKey(rid))) as string | null;
    return raw === null ? null : parse(raw);
  }
}

function requestKey(rid: string): string {
  return `${OAUTH_REQUEST_KEY_PREFIX}${rid}`;
}

function doneKey(rid: string): string {
  return `${OAUTH_REQUEST_DONE_KEY_PREFIX}${rid}`;
}

function parse(raw: string): OAuthPendingRequest {
  const value = JSON.parse(raw) as Partial<OAuthPendingRequest> & Record<string, unknown>;
  return {
    oauthClientId: String(value.oauthClientId),
    redirectUri: String(value.redirectUri),
    codeChallenge: String(value.codeChallenge),
    scope: String(value.scope),
    state: typeof value.state === 'string' ? value.state : null,
    device: typeof value.device === 'string' ? value.device : null,
    replaces: typeof value.replaces === 'string' ? value.replaces : null,
    createdAt: String(value.createdAt),
    boundOrganizationId:
      typeof value.boundOrganizationId === 'string' ? value.boundOrganizationId : null,
    approval: parseApproval(value.approval),
    // Fail closed: only an explicit `true` is a denial, only a complete approval an approval.
    denied: value.denied === true,
  };
}

function parseApproval(value: unknown): OAuthCodeApproval | null {
  if (typeof value !== 'object' || value === null) return null;
  const { agentId, name, approvedBy, replaces } = value as Record<string, unknown>;
  if (typeof agentId !== 'string' || typeof name !== 'string' || typeof approvedBy !== 'string') {
    return null;
  }
  return { agentId, name, approvedBy, replaces: typeof replaces === 'string' ? replaces : null };
}
