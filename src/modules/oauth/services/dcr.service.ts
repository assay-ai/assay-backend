import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';

import { OAUTH_CONFIG, OAuthConfig } from '../config/oauth.config';
import { ClientMetadataError, validateClientMetadata } from '../domain/client-metadata';
import { OAuthMetrics } from './oauth-metrics.service';
import {
  OAUTH_CLOCK,
  OAUTH_HOUR_SECONDS,
  OAUTH_RATE_LIMITS,
  OAuthRateLimiter,
} from './oauth-rate-limiter.service';

/** The RFC 7591 §3.2.1 response: no secret, no registration access token or URI. */
export interface DcrRegistrationResponse {
  readonly client_id: string;
  readonly client_id_issued_at: number;
  readonly client_name: string;
  readonly redirect_uris: string[];
  readonly grant_types: string[];
  readonly response_types: string[];
  readonly token_endpoint_auth_method: 'none';
}

export type DcrResult =
  /** 201 with `body`. */
  | { readonly ok: true; readonly body: DcrRegistrationResponse }
  /** 400 with the RFC 7591 error code, or 429 for `rate_limited`. */
  | { readonly ok: false; readonly error: ClientMetadataError | 'rate_limited' };

/**
 * Dynamic client registration, `POST {MCP}/oauth/register` (spec §6.3.8,
 * R-OA-10). Open, with no initial access token, so it accepts public clients
 * only, each redirect URI under §6.3.9, and at most 20 registrations an hour
 * from one client IP key (an IPv6 client by its /64). Every attempt counts,
 * refused ones included, so the limit also bounds probing. Fails closed.
 */
@Injectable()
export class DcrService {
  constructor(
    private readonly clients: OAuthClientRepository,
    private readonly limiter: OAuthRateLimiter,
    private readonly metrics: OAuthMetrics,
    @Inject(OAUTH_CONFIG) private readonly config: OAuthConfig,
    @Optional() @Inject(OAUTH_CLOCK) private readonly now: () => number = Date.now,
  ) {}

  async register(body: unknown, ipKey: string): Promise<DcrResult> {
    const allowed = await this.limiter.take(
      'dcr-ip',
      ipKey,
      OAUTH_RATE_LIMITS.dcrPerIpPerHour,
      OAUTH_HOUR_SECONDS,
    );
    if (!allowed) return { ok: false, error: 'rate_limited' };

    // A client_id is not the client's to choose.
    const checked = validateClientMetadata(withoutClientId(body), this.config.redirectAllowlist);
    if (checked.ok === false) return { ok: false, error: checked.error };
    const { value } = checked;

    const clientId = `dcr_${randomBytes(16).toString('base64url')}`;
    const issuedAt = Math.floor(this.now() / 1000);
    await this.clients.insertClient({
      clientId,
      kind: OAuthClientKind.DCR,
      clientName: value.clientName,
      clientUri: value.clientUri,
      redirectUris: value.redirectUris,
      metadata: { ...value.metadata, client_id: clientId, client_id_issued_at: issuedAt },
      fetchedAt: null,
      cacheUntil: null,
    });
    this.metrics.incDcr();

    return {
      ok: true,
      body: {
        client_id: clientId,
        client_id_issued_at: issuedAt,
        client_name: value.clientName,
        redirect_uris: value.redirectUris,
        grant_types: value.grantTypes,
        response_types: value.responseTypes,
        token_endpoint_auth_method: 'none',
      },
    };
  }
}

function withoutClientId(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const rest = { ...(body as Record<string, unknown>) };
  delete rest.client_id;
  return rest;
}
