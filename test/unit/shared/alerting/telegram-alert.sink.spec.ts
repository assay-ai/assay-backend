import { Logger } from '@nestjs/common';

import { EgressError, EgressFailureKind, EgressHttpClient } from '@shared/network/egress';

import {
  Alert,
  AlertSeverity,
  TelegramAlertSink,
  TelegramAlertSinkConfig,
  redactBotToken,
} from '@shared/alerting';

/**
 * `TelegramAlertSink` — the paging half of the observability Telegram sink.
 *
 * Same contract as `webhook-alert.sink.spec.ts`: `emit` must never reject,
 * must route by severity and by configuration state, and must never call the
 * real Telegram API — `EgressHttpClient` is faked as a bare
 * `{ request: jest.fn() }`, the same way `provider-connectivity.service.spec.ts`
 * and `webhook-alert.sink.spec.ts` fake it.
 *
 * The defect this suite exists to rule out: the bot token lives in the
 * request *path* (`https://api.telegram.org/bot<TOKEN>/sendMessage`), so a
 * careless failure log that includes the URL, or the underlying error's
 * message, leaks a live credential into the log stream. Several tests below
 * construct a failure whose only content IS the token-bearing URL and assert
 * it never reaches `Logger`.
 */
describe('TelegramAlertSink', () => {
  interface FakeHttpClient {
    request: jest.Mock;
  }

  const BOT_TOKEN = '123456789:AAExampleTelegramBotTokenForTestsOnly';
  const CHAT_ID = '-1001234567890';
  const TOKEN_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const baseAlert: Alert = {
    severity: AlertSeverity.CRITICAL,
    name: 'reserve_health_breach',
    summary: 'Reserve health breached: vault surplus is -100 below zero',
    details: { surplusAtomic: '-100' },
  };

  function buildConfig(overrides: Partial<TelegramAlertSinkConfig> = {}): TelegramAlertSinkConfig {
    return {
      enabled: true,
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      minSeverity: AlertSeverity.WARN,
      timeoutMs: 5000,
      ...overrides,
    };
  }

  function buildSink(config: TelegramAlertSinkConfig) {
    const http: FakeHttpClient = { request: jest.fn() };
    const sink = new TelegramAlertSink(http as unknown as EgressHttpClient, config);
    return { http, sink };
  }

  function spyOnLoggerText(): jest.SpyInstance {
    // `Logger` (nest) proxies to the process-wide logger instance; spying on
    // the prototype method lets us observe what a real deploy would emit
    // without wiring a full Nest app. We only assert on the *string content*
    // passed to `warn`.
    return jest.spyOn(Logger.prototype, 'warn');
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

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

  it('treats a missing chat id as "not configured": never throws, never calls the transport', async () => {
    const { http, sink } = buildSink(buildConfig({ chatId: undefined }));

    await expect(sink.emit(baseAlert)).resolves.toBeUndefined();
    await expect(sink.emit(baseAlert)).resolves.toBeUndefined();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('warns about a missing chat id only once, not once per alert', async () => {
    const warnSpy = spyOnLoggerText();
    const { sink } = buildSink(buildConfig({ chatId: undefined }));

    await sink.emit(baseAlert);
    await sink.emit(baseAlert);
    await sink.emit(baseAlert);

    const chatIdWarnings = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes('ALERT_TELEGRAM_CHAT_ID'),
    );
    expect(chatIdWarnings).toHaveLength(1);
  });

  it('never throws when the bot token is missing, and never calls the transport', async () => {
    const { http, sink } = buildSink(buildConfig({ botToken: undefined }));

    await expect(sink.emit(baseAlert)).resolves.toBeUndefined();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('posts to the Telegram sendMessage endpoint for the configured bot and chat', async () => {
    const { http, sink } = buildSink(buildConfig());
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: '{"ok":true}',
      bytes: 11,
      url: TOKEN_URL,
      redirects: 0,
    });

    await sink.emit(baseAlert);

    expect(http.request).toHaveBeenCalledTimes(1);
    const call = http.request.mock.calls[0][0];
    expect(call.url).toBe(TOKEN_URL);
    expect(call.method).toBe('POST');
    expect(call.headers).toEqual({ 'content-type': 'application/json' });
    expect(call.policy.trust).toBe('PUBLIC_ONLY');
    expect(call.policy.limits.totalTimeoutMs).toBe(5000);

    const payload = JSON.parse(call.body);
    expect(payload.chat_id).toBe(CHAT_ID);
    expect(payload.text).toContain('reserve_health_breach');
    expect(payload.text).toContain(baseAlert.summary);
    expect(payload.text).toContain('surplusAtomic');
    // Plain text — no parse_mode, so MarkdownV2 escaping can never reject
    // the message.
    expect(payload.parse_mode).toBeUndefined();
  });

  it('omits message_thread_id entirely when no topic is configured', async () => {
    const { http, sink } = buildSink(buildConfig());

    await sink.emit(baseAlert);

    const payload = JSON.parse(http.request.mock.calls[0][0].body);
    // Not `null`, not `0` — absent. Telegram rejects `message_thread_id` on a
    // chat that is not a forum, so sending it "empty" would break every
    // non-forum target rather than degrade.
    expect('message_thread_id' in payload).toBe(false);
  });

  it('sends message_thread_id when the target group has a topic', async () => {
    const { http, sink } = buildSink(buildConfig({ messageThreadId: 3 }));

    await sink.emit(baseAlert);

    const payload = JSON.parse(http.request.mock.calls[0][0].body);
    expect(payload.message_thread_id).toBe(3);
    expect(payload.chat_id).toBe(CHAT_ID);
  });

  it('leaves CRITICAL alerts loud (quiet hours never apply to Critical)', async () => {
    const { http, sink } = buildSink(buildConfig());
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: 'ok',
      bytes: 2,
      url: TOKEN_URL,
      redirects: 0,
    });

    await sink.emit({ ...baseAlert, severity: AlertSeverity.CRITICAL });

    const payload = JSON.parse(http.request.mock.calls[0][0].body);
    expect(payload.disable_notification).toBe(false);
  });

  it.each([AlertSeverity.WARN, AlertSeverity.INFO])(
    'silences %s alerts via disable_notification',
    async (severity) => {
      const { http, sink } = buildSink(buildConfig({ minSeverity: AlertSeverity.INFO }));
      http.request.mockResolvedValue({
        status: 200,
        headers: {},
        body: 'ok',
        bytes: 2,
        url: TOKEN_URL,
        redirects: 0,
      });

      await sink.emit({ ...baseAlert, severity });

      const payload = JSON.parse(http.request.mock.calls[0][0].body);
      expect(payload.disable_notification).toBe(true);
    },
  );

  it('applies the configured timeout to the egress policy', async () => {
    const { http, sink } = buildSink(buildConfig({ timeoutMs: 1500 }));
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: 'ok',
      bytes: 2,
      url: TOKEN_URL,
      redirects: 0,
    });

    await sink.emit(baseAlert);

    expect(http.request.mock.calls[0][0].policy.limits.totalTimeoutMs).toBe(1500);
  });

  it('never rejects when the transport throws', async () => {
    const { http, sink } = buildSink(buildConfig());
    http.request.mockRejectedValue(
      new EgressError(EgressFailureKind.TIMEOUT, 'total request budget spent', { url: TOKEN_URL }),
    );

    await expect(sink.emit(baseAlert)).resolves.toBeUndefined();
  });

  it('never rejects on a non-2xx response from Telegram', async () => {
    const { http, sink } = buildSink(buildConfig());
    http.request.mockResolvedValue({
      status: 404,
      headers: {},
      body: '{"ok":false,"error_code":404,"description":"Not Found"}',
      bytes: 40,
      url: TOKEN_URL,
      redirects: 0,
    });

    await expect(sink.emit(baseAlert)).resolves.toBeUndefined();
  });

  it('never logs the bot token when the transport throws an EgressError carrying the token-bearing URL', async () => {
    const warnSpy = spyOnLoggerText();
    // The EgressError's own `.message` and `.url` embed the full URL — this
    // is exactly the shape a real timeout/connection failure would carry.
    const failure = new EgressError(EgressFailureKind.CONNECTION_FAILED, 'socket reset', {
      url: TOKEN_URL,
    });
    expect(failure.message).toContain(BOT_TOKEN);

    const httpThatThrows = { request: jest.fn().mockRejectedValue(failure) };
    const sinkUnderTest = new TelegramAlertSink(
      httpThatThrows as unknown as EgressHttpClient,
      buildConfig(),
    );

    await sinkUnderTest.emit(baseAlert);

    for (const call of warnSpy.mock.calls) {
      expect(String(call[0])).not.toContain(BOT_TOKEN);
    }
  });

  it('never logs the bot token when Telegram returns a non-2xx whose body happens to echo the URL', async () => {
    const warnSpy = spyOnLoggerText();
    const { http, sink } = buildSink(buildConfig());
    http.request.mockResolvedValue({
      status: 400,
      headers: {},
      // Adversarial: a response body that itself contains the request URL,
      // to prove redaction is not merely "don't log `response.url`".
      body: `bad request for ${TOKEN_URL}`,
      bytes: 80,
      url: TOKEN_URL,
      redirects: 0,
    });

    await sink.emit(baseAlert);

    for (const call of warnSpy.mock.calls) {
      expect(String(call[0])).not.toContain(BOT_TOKEN);
    }
  });

  describe('redactBotToken (pure function)', () => {
    it('strips every occurrence of the token from a string', () => {
      const text = `failed calling ${TOKEN_URL} and also ${TOKEN_URL}`;
      const result = redactBotToken(text, BOT_TOKEN);

      expect(result).not.toContain(BOT_TOKEN);
      expect(result).toContain('[REDACTED_TELEGRAM_TOKEN]');
    });

    it('is a no-op when there is no token to redact', () => {
      expect(redactBotToken('no secrets here', undefined)).toBe('no secrets here');
    });
  });

  describe('rate limiting', () => {
    it('drops sends beyond the per-window cap and still resolves', async () => {
      const { http, sink } = buildSink(buildConfig());
      http.request.mockResolvedValue({
        status: 200,
        headers: {},
        body: 'ok',
        bytes: 2,
        url: TOKEN_URL,
        redirects: 0,
      });

      // 20 is the documented cap; the 21st in the same window must be
      // dropped rather than sent or thrown.
      for (let i = 0; i < 20; i += 1) {
        await sink.emit(baseAlert);
      }
      expect(http.request).toHaveBeenCalledTimes(20);

      await expect(sink.emit(baseAlert)).resolves.toBeUndefined();
      expect(http.request).toHaveBeenCalledTimes(20);
    });
  });
});
