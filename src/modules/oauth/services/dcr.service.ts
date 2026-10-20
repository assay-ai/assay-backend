import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';

import { OAUTH_CONFIG, OAuthConfig } from '../config/oauth.config';
import { ClientMetadataError, validateClientMetadata } from '../domain/client-metadata';
import {
  OAUTH_CLOCK,
  OAUTH_DAY_SECONDS,
  OAUTH_HOUR_SECONDS,
  OAUTH_RATE_LIMITS,
  OAuthRateLimiter,
  oauthIpv6Prefix48,
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
 * only, each redirect URI under §6.3.9, and bounds how many rows strangers
 * can create. Every limit fails closed:
 *
 * ```text
 * per IP key (IPv4, IPv6 /64)   20 attempts / hour            refused ones count too
 * per IPv6 /48                  OAUTH_DCR_PER_48_PER_HOUR      (default 50) attempts / hour
 * all clients                   OAUTH_DCR_GLOBAL_PER_DAY       (default 1000) valid registrations / UTC day
 * ```
 *
 * Over 100 registrations in a UTC day under one `client_name` log
 * `dcr.client_name_flood`; the name is counted by its hash. The operator
 * dashboard's `OAUTH_DCR_REGISTRATIONS` signal raises the §6.3.8 alert from
 * the `oauth_clients` rows themselves.
 */
@Injectable()
export class DcrService {
  private readonly logger = new Logger(DcrService.name);

  constructor(
    private readonly clients: OAuthClientRepository,
    private readonly limiter: OAuthRateLimiter,
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
    const prefix48 = oauthIpv6Prefix48(ipKey);
    if (
      prefix48 !== null &&
      !(await this.limiter.take(
        'dcr-48',
        prefix48,
        this.config.dcrPer48PerHour,
        OAUTH_HOUR_SECONDS,
      ))
    ) {
      return { ok: false, error: 'rate_limited' };
    }

    // A client_id is not the client's to choose.
    const checked = validateClientMetadata(withoutClientId(body), this.config.redirectAllowlist);
    if (checked.ok === false) return { ok: false, error: checked.error };
    const { value } = checked;

    const withinDailyCap = await this.limiter.take(
      'dcr-all',
      'all',
      this.config.dcrGlobalPerDay,
      OAUTH_DAY_SECONDS,
    );
    if (!withinDailyCap) return { ok: false, error: 'rate_limited' };

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
    await this.countClientName(value.clientName);

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

  private async countClientName(clientName: string): Promise<void> {
    const nameHash = createHash('sha256').update(clientName).digest('hex').slice(0, 32);
    const count = await this.limiter.count('dcr-name', nameHash, OAUTH_DAY_SECONDS);
    if (count !== null && count > OAUTH_RATE_LIMITS.dcrPerClientNamePerDay) {
      this.logger.warn(`dcr.client_name_flood nameHash=${nameHash} count=${count}`);
    }
  }
}

function withoutClientId(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const rest = { ...(body as Record<string, unknown>) };
  delete rest.client_id;
  return rest;
}
