import { Test } from '@nestjs/testing';

import { OAuthMetrics } from '@modules/oauth/services/oauth-metrics.service';
import { MetricsRegistryModule } from '@modules/observability/metrics-registry.module';
import { ObservabilityModule } from '@modules/observability/observability.module';
import { MetricsRegistryService } from '@modules/observability/services/metrics-registry.service';

describe('OAuthMetrics', () => {
  function setup() {
    const registry = new MetricsRegistryService();
    return { registry, metrics: new OAuthMetrics(registry) };
  }

  it('registers every §6.7 metric on the shared registry', async () => {
    const { registry } = setup();
    const text = await registry.metricsText();

    for (const name of [
      'assay_oauth_authorize_total',
      'assay_oauth_consent_total',
      'assay_oauth_token_total',
      'assay_oauth_refresh_grace_total',
      'assay_oauth_refresh_reuse_total',
      'assay_oauth_cimd_fetch_total',
      'assay_oauth_dcr_total',
      'assay_mcp_unauthorized_total',
      'assay_oauth_live_grants_per_agent',
    ]) {
      expect(text).toContain(`# TYPE ${name} `);
    }
    expect(text).toContain('# TYPE assay_oauth_live_grants_per_agent gauge');
  });

  it('counts under the §6.7 labels', async () => {
    const { registry, metrics } = setup();

    metrics.incAuthorize('stored');
    metrics.incConsent('continue_cookie_missing');
    metrics.incToken('authorization_code', 'ok');
    metrics.incToken('refresh_token', 'invalid_grant');
    metrics.incToken('authorization_code', 'rate_limited');
    metrics.incRefreshGrace();
    metrics.incRefreshReuse('revoked');
    metrics.incCimdFetch('blocked_address');
    metrics.incDcr();
    metrics.incMcpUnauthorized('audience');
    metrics.setLiveGrantsPerAgentMax(45);

    const text = await registry.metricsText();
    expect(text).toContain('assay_oauth_authorize_total{outcome="stored"} 1');
    expect(text).toContain('assay_oauth_consent_total{step="continue_cookie_missing"} 1');
    expect(text).toContain(
      'assay_oauth_token_total{grant_type="authorization_code",result="ok"} 1',
    );
    expect(text).toContain(
      'assay_oauth_token_total{grant_type="refresh_token",result="invalid_grant"} 1',
    );
    expect(text).toContain(
      'assay_oauth_token_total{grant_type="authorization_code",result="rate_limited"} 1',
    );
    expect(text).toContain('assay_oauth_refresh_grace_total 1');
    expect(text).toContain('assay_oauth_refresh_reuse_total{kind="revoked"} 1');
    expect(text).toContain('assay_oauth_cimd_fetch_total{result="blocked_address"} 1');
    expect(text).toContain('assay_oauth_dcr_total 1');
    expect(text).toContain('assay_mcp_unauthorized_total{reason="audience"} 1');
    expect(text).toContain('assay_oauth_live_grants_per_agent 45');
  });

  it('two instances on two registries do not collide', () => {
    expect(() => {
      setup();
      setup();
    }).not.toThrow();
  });

  it('resolves against MetricsRegistryModule alone, as the MCP app will import it', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MetricsRegistryModule],
      providers: [OAuthMetrics],
    }).compile();

    moduleRef.get(OAuthMetrics).incDcr();
    const text = await moduleRef.get(MetricsRegistryService).metricsText();
    expect(text).toContain('assay_oauth_dcr_total 1');
  });

  it('ObservabilityModule re-exports the registry module, so a container has one registry', () => {
    const meta = (key: string) =>
      (Reflect.getMetadata(key, ObservabilityModule) ?? []) as unknown[];
    expect(meta('imports')).toContain(MetricsRegistryModule);
    expect(meta('exports')).toContain(MetricsRegistryModule);
    expect(meta('providers')).not.toContain(MetricsRegistryService);
  });
});
