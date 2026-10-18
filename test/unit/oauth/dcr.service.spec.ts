import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { DcrService } from '@modules/oauth/services/dcr.service';
import { oauthIpKey } from '@modules/oauth/services/oauth-rate-limiter.service';

import {
  CHATGPT_REDIRECT,
  Clock,
  FakeOAuthClientRepository,
  FakeOAuthRedis,
  counterValue,
  oauthConfig,
  oauthMetrics,
  rateLimiter,
} from './helpers/oauth-fakes';

const IP = oauthIpKey('2001:db8:1:2:aaaa::1');

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_name: 'Visual Studio Code',
    redirect_uris: ['http://127.0.0.1/', 'http://localhost:33418/callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...overrides,
  };
}

function setup() {
  const redis = new FakeOAuthRedis();
  const repo = new FakeOAuthClientRepository();
  const clock = new Clock();
  const { metrics, registry } = oauthMetrics();
  const service = new DcrService(
    repo as unknown as OAuthClientRepository,
    rateLimiter(redis, clock),
    metrics,
    oauthConfig(),
    clock.now,
  );
  return { service, repo, redis, clock, registry };
}

describe('DcrService (§6.3.8)', () => {
  it('registers a public client and returns the 201 body', async () => {
    const { service, repo, clock, registry } = setup();

    const result = await service.register(body({ client_uri: 'https://code.example.com' }), IP);

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.body.client_id).toMatch(/^dcr_[A-Za-z0-9_-]{22}$/);
    expect(result.body).toEqual({
      client_id: result.body.client_id,
      client_id_issued_at: Math.floor(clock.ms / 1000),
      client_name: 'Visual Studio Code',
      redirect_uris: ['http://127.0.0.1/', 'http://localhost:33418/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    const row = repo.rows.get(result.body.client_id)!;
    expect(row.kind).toBe(OAuthClientKind.DCR);
    expect(row.clientUri).toBe('https://code.example.com');
    expect(row.fetchedAt).toBeNull();
    expect(row.cacheUntil).toBeNull();
    expect(await counterValue(registry, 'assay_oauth_dcr_total')).toBe(1);
  });

  it('returns no secret and no registration_access_token', async () => {
    const { service } = setup();
    const result = await service.register(body(), IP);
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    const keys = Object.keys(result.body);
    expect(keys.some((key) => key.startsWith('client_secret'))).toBe(false);
    expect(keys).not.toContain('registration_access_token');
    expect(keys).not.toContain('registration_client_uri');
  });

  it('issues a different client_id each time', async () => {
    const { service } = setup();
    const a = await service.register(body(), IP);
    const b = await service.register(body(), IP);
    expect(a.ok === true && b.ok === true && a.body.client_id !== b.body.client_id).toBe(true);
  });

  it('client_secret_post refused', async () => {
    const { service, repo } = setup();
    expect(
      await service.register(body({ token_endpoint_auth_method: 'client_secret_post' }), IP),
    ).toEqual({ ok: false, error: 'invalid_client_metadata' });
    expect(
      await service.register(body({ token_endpoint_auth_method: 'client_secret_basic' }), IP),
    ).toEqual({ ok: false, error: 'invalid_client_metadata' });
    expect(repo.rows.size).toBe(0);
  });

  it('any client_secret* member refused', async () => {
    const { service } = setup();
    for (const member of ['client_secret', 'client_secret_expires_at']) {
      expect(await service.register(body({ [member]: 'x' }), IP)).toEqual({
        ok: false,
        error: 'invalid_client_metadata',
      });
    }
  });

  it('bad redirect refused', async () => {
    const { service, repo } = setup();
    for (const redirects of [
      [],
      ['https://evil.example.net/cb'],
      ['http://127.0.0.1/cb', 'https://evil.example.net/cb'],
      ['http://127.0.0.1/cb?x=1'],
      ['http://127.0.0.1/cb#f'],
      ['https://claude.ai/api/mcp/auth_callback'],
      Array.from({ length: 11 }, (_, i) => `http://127.0.0.1/cb${i}`),
      'http://127.0.0.1/cb',
      [42],
    ]) {
      expect(await service.register(body({ redirect_uris: redirects }), IP)).toEqual({
        ok: false,
        error: 'invalid_redirect_uri',
      });
    }
    expect(await service.register(body({ redirect_uris: undefined }), IP)).toEqual({
      ok: false,
      error: 'invalid_redirect_uri',
    });
    expect(repo.rows.size).toBe(0);
  });

  it('accepts an allowlisted HTTPS redirect', async () => {
    const { service } = setup();
    const result = await service.register(body({ redirect_uris: [CHATGPT_REDIRECT] }), IP);
    expect(result.ok).toBe(true);
  });

  it('refuses a missing or unsafe name and a body that is not an object', async () => {
    const { service } = setup();
    for (const candidate of [
      body({ client_name: undefined }),
      body({ client_name: '' }),
      body({ client_name: 'x'.repeat(65) }),
      body({ client_name: '‮​' }),
      body({ grant_types: ['implicit'] }),
      body({ response_types: ['token'] }),
      body({ client_uri: 'javascript:alert(1)' }),
      null,
      [],
      'text',
    ]) {
      expect(await service.register(candidate, IP)).toEqual({
        ok: false,
        error: 'invalid_client_metadata',
      });
    }
  });

  it('known members only: others are ignored and not stored', async () => {
    const { service, repo } = setup();
    const result = await service.register(
      body({ logo_uri: 'https://x.example.com/l.png', jwks_uri: 'https://x.example.com/j' }),
      IP,
    );
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    const metadata = repo.rows.get(result.body.client_id)!.metadata;
    expect(metadata).not.toHaveProperty('logo_uri');
    expect(metadata).not.toHaveProperty('jwks_uri');
    expect(result.body).not.toHaveProperty('logo_uri');
  });

  it('defaults grant_types and response_types when absent', async () => {
    const { service } = setup();
    const result = await service.register(
      body({
        grant_types: undefined,
        response_types: undefined,
        token_endpoint_auth_method: undefined,
      }),
      IP,
    );
    expect(result.ok === true && result.body.grant_types).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    expect(result.ok === true && result.body.response_types).toEqual(['code']);
    expect(result.ok === true && result.body.token_endpoint_auth_method).toBe('none');
  });

  it('21st per /64 in an hour refused', async () => {
    const { service, clock } = setup();
    for (let i = 0; i < 20; i += 1) {
      const ip = oauthIpKey(`2001:db8:1:2::${i + 1}`);
      expect((await service.register(body(), ip)).ok).toBe(true);
    }
    expect(await service.register(body(), oauthIpKey('2001:db8:1:2:ffff::9'))).toEqual({
      ok: false,
      error: 'rate_limited',
    });
    // Another /64 is not affected.
    expect((await service.register(body(), oauthIpKey('2001:db8:1:3::1'))).ok).toBe(true);
    // The next hour starts afresh.
    clock.advance(3600);
    expect((await service.register(body(), IP)).ok).toBe(true);
  });

  it('refused registrations count toward the limit too', async () => {
    const { service } = setup();
    for (let i = 0; i < 20; i += 1) {
      await service.register(body({ redirect_uris: [] }), IP);
    }
    expect(await service.register(body(), IP)).toEqual({ ok: false, error: 'rate_limited' });
  });

  it('fails closed when the rate counter is unreachable', async () => {
    const { service, redis, repo } = setup();
    redis.down = true;
    expect(await service.register(body(), IP)).toEqual({ ok: false, error: 'rate_limited' });
    expect(repo.rows.size).toBe(0);
  });
});
