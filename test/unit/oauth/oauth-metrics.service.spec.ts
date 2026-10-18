import { OAuthMetrics } from '@modules/oauth/services/oauth-metrics.service';
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
      'oauth_authorize_total',
      'oauth_consent_total',
      'oauth_token_total',
      'oauth_refresh_grace_total',
      'oauth_refresh_reuse_total',
      'oauth_cimd_fetch_total',
      'oauth_dcr_total',
      'mcp_unauthorized_total',
      'oauth_live_grants_per_agent',
    ]) {
      expect(text).toContain(`# TYPE ${name} `);
    }
    expect(text).toContain('# TYPE oauth_live_grants_per_agent gauge');
  });

  it('counts under the §6.7 labels', async () => {
    const { registry, metrics } = setup();

    metrics.incAuthorize('stored');
    metrics.incConsent('continue_cookie_missing');
    metrics.incToken('authorization_code', 'ok');
    metrics.incToken('refresh_token', 'invalid_grant');
    metrics.incRefreshGrace();
    metrics.incRefreshReuse('revoked');
    metrics.incCimdFetch('blocked_address');
    metrics.incDcr();
    metrics.incMcpUnauthorized('audience');
    metrics.setLiveGrantsPerAgentMax(45);

    const text = await registry.metricsText();
    expect(text).toContain('oauth_authorize_total{outcome="stored"} 1');
    expect(text).toContain('oauth_consent_total{step="continue_cookie_missing"} 1');
    expect(text).toContain('oauth_token_total{grant_type="authorization_code",result="ok"} 1');
    expect(text).toContain(
      'oauth_token_total{grant_type="refresh_token",result="invalid_grant"} 1',
    );
    expect(text).toContain('oauth_refresh_grace_total 1');
    expect(text).toContain('oauth_refresh_reuse_total{kind="revoked"} 1');
    expect(text).toContain('oauth_cimd_fetch_total{result="blocked_address"} 1');
    expect(text).toContain('oauth_dcr_total 1');
    expect(text).toContain('mcp_unauthorized_total{reason="audience"} 1');
    expect(text).toContain('oauth_live_grants_per_agent 45');
  });

  it('two instances on two registries do not collide', () => {
    expect(() => {
      setup();
      setup();
    }).not.toThrow();
  });
});
