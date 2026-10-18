import { Injectable } from '@nestjs/common';
import { Counter } from 'prom-client';

import { MetricsRegistryService } from '@modules/observability/services/metrics-registry.service';

/** `oauth_authorize_total{outcome}` (spec §6.7). */
export type OAuthAuthorizeOutcome =
  | 'stored'
  | 'client_unknown'
  | 'client_metadata_invalid'
  | 'redirect_uri_mismatch'
  | 'invalid_request'
  | 'invalid_target'
  | 'rate_limited';

/** `oauth_consent_total{step}`. */
export type OAuthConsentStep =
  | 'shown'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'continue_cookie_missing';

/**
 * `oauth_token_total{grant_type}`. Anything other than the two supported
 * grants is counted as `other`, so a client cannot mint label values.
 */
export type OAuthTokenGrantType = 'authorization_code' | 'refresh_token' | 'other';

/**
 * `oauth_token_total{result}`: `ok`, the RFC 6749 §5.2 / RFC 8707 error code,
 * or `rate_limited` for the 429 of §6.3.10.
 */
export type OAuthTokenResult =
  | 'ok'
  | 'rate_limited'
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'temporarily_unavailable';

/** `oauth_refresh_reuse_total{kind}` (§6.3.11). */
export type OAuthRefreshReuseKind = 'revoked' | 'stale';

/** `oauth_cimd_fetch_total{result}` (§6.3.7). */
export type OAuthCimdFetchResult =
  | 'ok'
  | 'timeout'
  | 'too_large'
  | 'status'
  | 'invalid'
  | 'blocked_address'
  | 'budget';

/** `mcp_unauthorized_total{reason}`. */
export type McpUnauthorizedReason = 'missing' | 'unknown' | 'expired' | 'revoked' | 'audience';

/**
 * The OAuth metrics of spec §6.7, on the registry `MetricsRegistryService`
 * owns. Call sites only use the `inc*` / `set*` methods below; the label
 * values are closed unions, so no request value ever becomes a label.
 *
 * Names are the spec's with the house `assay_` prefix (`oauth_token_total` is
 * `assay_oauth_token_total`); alerts written from §6.7 must add it. Provided
 * once per container (by `OAuthCoreModule`), with `MetricsRegistryModule`
 * imported: a second instance on the same registry throws. Alerts (in the spec, not here):
 * `continue_cookie_missing` above 5 % of `approved` over 1 h; any
 * `oauth_refresh_reuse_total{kind="revoked"}`; any
 * `oauth_cimd_fetch_total{result="blocked_address"}`; §6.3.8's DCR thresholds.
 *
 * The §6.7 gauge `assay_oauth_live_grants_per_agent` is not here: it is read
 * from the database, so it lives with the other DB-backed gauges on
 * `MetricsRegistryService` and `MetricsCollectorService` sets it.
 */
@Injectable()
export class OAuthMetrics {
  private readonly authorizeTotal: Counter<'outcome'>;
  private readonly consentTotal: Counter<'step'>;
  private readonly tokenTotal: Counter<'grant_type' | 'result'>;
  private readonly refreshGraceTotal: Counter;
  private readonly refreshReuseTotal: Counter<'kind'>;
  private readonly cimdFetchTotal: Counter<'result'>;
  private readonly dcrTotal: Counter;
  private readonly dcrClientNameFloodTotal: Counter;
  private readonly mcpUnauthorizedTotal: Counter<'reason'>;

  constructor(metrics: MetricsRegistryService) {
    const registers = [metrics.registry];

    this.authorizeTotal = new Counter({
      name: 'assay_oauth_authorize_total',
      help: 'GET /oauth/authorize outcomes.',
      labelNames: ['outcome'] as const,
      registers,
    });
    this.consentTotal = new Counter({
      name: 'assay_oauth_consent_total',
      help: 'Consent steps. Alert: continue_cookie_missing > 5% of approved over 1h.',
      labelNames: ['step'] as const,
      registers,
    });
    this.tokenTotal = new Counter({
      name: 'assay_oauth_token_total',
      help: 'POST /oauth/token results, by grant type.',
      labelNames: ['grant_type', 'result'] as const,
      registers,
    });
    this.refreshGraceTotal = new Counter({
      name: 'assay_oauth_refresh_grace_total',
      help: 'Rotated refresh tokens answered from the 30s grace entry.',
      registers,
    });
    this.refreshReuseTotal = new Counter({
      name: 'assay_oauth_refresh_reuse_total',
      help: 'Rotated refresh tokens presented after the grace. Alert: kind="revoked" > 0.',
      labelNames: ['kind'] as const,
      registers,
    });
    this.cimdFetchTotal = new Counter({
      name: 'assay_oauth_cimd_fetch_total',
      help: 'Client ID metadata document fetches. Alert: result="blocked_address" > 0.',
      labelNames: ['result'] as const,
      registers,
    });
    this.dcrTotal = new Counter({
      name: 'assay_oauth_dcr_total',
      help: 'Dynamic client registrations. Alert above 1000/day, or 100/day for one client_name.',
      registers,
    });
    this.dcrClientNameFloodTotal = new Counter({
      name: 'assay_oauth_dcr_client_name_flood_total',
      help: 'DCR registrations past 100 in one UTC day under one client_name. Alert: > 0.',
      registers,
    });
    this.mcpUnauthorizedTotal = new Counter({
      name: 'assay_mcp_unauthorized_total',
      help: '401s from the MCP catch-all, by reason.',
      labelNames: ['reason'] as const,
      registers,
    });
  }

  incAuthorize(outcome: OAuthAuthorizeOutcome): void {
    this.authorizeTotal.labels(outcome).inc();
  }

  incConsent(step: OAuthConsentStep): void {
    this.consentTotal.labels(step).inc();
  }

  incToken(grantType: OAuthTokenGrantType, result: OAuthTokenResult): void {
    this.tokenTotal.labels(grantType, result).inc();
  }

  incRefreshGrace(): void {
    this.refreshGraceTotal.inc();
  }

  incRefreshReuse(kind: OAuthRefreshReuseKind): void {
    this.refreshReuseTotal.labels(kind).inc();
  }

  incCimdFetch(result: OAuthCimdFetchResult): void {
    this.cimdFetchTotal.labels(result).inc();
  }

  incDcr(): void {
    this.dcrTotal.inc();
  }

  /** A registration past the per-`client_name` daily threshold (§6.3.8 alert). */
  incDcrClientNameFlood(): void {
    this.dcrClientNameFloodTotal.inc();
  }

  incMcpUnauthorized(reason: McpUnauthorizedReason): void {
    this.mcpUnauthorizedTotal.labels(reason).inc();
  }
}
