import { EgressError, EgressFailureKind, EgressHttpClient } from '@shared/network/egress';

import { Alert, AlertSeverity, WebhookAlertSink, WebhookAlertSinkConfig } from '@shared/alerting';

/**
 * `WebhookAlertSink` — the off-platform half of alerting.
 *
 * The contract under test is `AlertPort`'s own: `emit` must never reject, no
 * matter what the transport does, and it must route by severity rather than
 * blast every alert at every configured URL. `EgressHttpClient` is faked the
 * same way `provider-connectivity.service.spec.ts` fakes it — a bare
 * `{ request: jest.fn() }` — because it is an infra client, not a repository;
 * there is no `rows` map for an HTTP call.
 */
describe('WebhookAlertSink', () => {
  interface FakeHttpClient {
    request: jest.Mock;
  }

  const CRITICAL_URL = 'https://hooks.example.test/critical';
  const WARN_URL = 'https://hooks.example.test/warn';

  const baseAlert: Alert = {
    severity: AlertSeverity.CRITICAL,
    name: 'reserve_health_breach',
    summary: 'Reserve health breached: vault surplus is -100 below zero',
    details: { surplusAtomic: '-100' },
  };

  function buildConfig(overrides: Partial<WebhookAlertSinkConfig> = {}): WebhookAlertSinkConfig {
    return {
      enabled: true,
      urlBySeverity: { [AlertSeverity.CRITICAL]: CRITICAL_URL, [AlertSeverity.WARN]: WARN_URL },
      minSeverity: AlertSeverity.WARN,
      timeoutMs: 5000,
      ...overrides,
    };
  }

  function buildSink(config: WebhookAlertSinkConfig) {
    const http: FakeHttpClient = { request: jest.fn() };
    const sink = new WebhookAlertSink(http as unknown as EgressHttpClient, config);
    return { http, sink };
  }

  it('never rejects when disabled, and never calls the transport', async () => {
    const { http, sink } = buildSink(buildConfig({ enabled: false }));

    await expect(sink.emit(baseAlert)).resolves.toBeUndefined();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('drops an alert below the configured floor without calling the transport', async () => {
    const { http, sink } = buildSink(buildConfig({ minSeverity: AlertSeverity.CRITICAL }));

    await sink.emit({ ...baseAlert, severity: AlertSeverity.WARN });

    expect(http.request).not.toHaveBeenCalled();
  });

  it('drops an alert whose severity has no configured URL, without throwing', async () => {
    const { http, sink } = buildSink(
      buildConfig({ urlBySeverity: { [AlertSeverity.CRITICAL]: CRITICAL_URL } }),
    );

    await expect(
      sink.emit({ ...baseAlert, severity: AlertSeverity.WARN }),
    ).resolves.toBeUndefined();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('posts a Slack-compatible payload to the URL for the alert severity, under PUBLIC_ONLY', async () => {
    const { http, sink } = buildSink(buildConfig());
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: 'ok',
      bytes: 2,
      url: CRITICAL_URL,
      redirects: 0,
    });

    await sink.emit(baseAlert);

    expect(http.request).toHaveBeenCalledTimes(1);
    const call = http.request.mock.calls[0][0];
    expect(call.url).toBe(CRITICAL_URL);
    expect(call.method).toBe('POST');
    expect(call.headers).toEqual({ 'content-type': 'application/json' });
    expect(call.policy.trust).toBe('PUBLIC_ONLY');
    expect(call.policy.limits.totalTimeoutMs).toBe(5000);

    const payload = JSON.parse(call.body);
    expect(payload.text).toContain('[CRITICAL] reserve_health_breach');
    expect(payload.blocks[0].text.text).toContain(baseAlert.summary);
    expect(payload.blocks[1].text.text).toContain('surplusAtomic');
  });

  it('routes WARN and CRITICAL to their own configured URLs', async () => {
    const { http, sink } = buildSink(buildConfig());
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: 'ok',
      bytes: 2,
      url: WARN_URL,
      redirects: 0,
    });

    await sink.emit({ ...baseAlert, severity: AlertSeverity.WARN });

    expect(http.request.mock.calls[0][0].url).toBe(WARN_URL);
  });

  it('applies the configured timeout to the egress policy', async () => {
    const { http, sink } = buildSink(buildConfig({ timeoutMs: 1500 }));
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: 'ok',
      bytes: 2,
      url: CRITICAL_URL,
      redirects: 0,
    });

    await sink.emit(baseAlert);

    expect(http.request.mock.calls[0][0].policy.limits.totalTimeoutMs).toBe(1500);
  });

  it('never rejects when the transport throws — a dead endpoint must not lose the alert', async () => {
    const { http, sink } = buildSink(buildConfig());
    http.request.mockRejectedValue(
      new EgressError(EgressFailureKind.TIMEOUT, 'total request budget spent', {
        url: CRITICAL_URL,
      }),
    );

    await expect(sink.emit(baseAlert)).resolves.toBeUndefined();
  });

  it('never rejects on a non-2xx response from the webhook receiver', async () => {
    const { http, sink } = buildSink(buildConfig());
    http.request.mockResolvedValue({
      status: 404,
      headers: {},
      body: 'no such channel',
      bytes: 16,
      url: CRITICAL_URL,
      redirects: 0,
    });

    await expect(sink.emit(baseAlert)).resolves.toBeUndefined();
  });
});
