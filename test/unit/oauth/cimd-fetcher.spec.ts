import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { OAuthConfig } from '@modules/oauth/config/oauth.config';
import { CimdFetcher } from '@modules/oauth/services/cimd.fetcher';
import {
  EgressError,
  EgressFailureKind,
  EgressHttpClient,
  EgressResponse,
  EgressTrust,
} from '@shared/network/egress';

import { FakeEgressHttpClient } from '../auth/helpers/fake-egress';
import {
  CHATGPT_REDIRECT,
  Clock,
  FakeOAuthClientRepository,
  FakeOAuthRedis,
  counterValue,
  fakeCache,
  oauthConfig,
  oauthMetrics,
  rateLimiter,
} from './helpers/oauth-fakes';

const URL_A = 'https://app.example.com/oauth/client.json';
const VERIFIED_URL = 'https://verified.example.org/oauth/client.json';
const IP = '203.0.113.7';

function document(url = URL_A, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: url,
    client_name: 'Example App',
    redirect_uris: ['http://127.0.0.1/callback', CHATGPT_REDIRECT],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...overrides,
  };
}

function response(
  body: string,
  headers: Record<string, string> = {},
  status = 200,
): EgressResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body,
    bytes: Buffer.byteLength(body),
    url: URL_A,
    redirects: 0,
  };
}

function setup(config: OAuthConfig = oauthConfig()) {
  const egress = new FakeEgressHttpClient();
  const redis = new FakeOAuthRedis();
  const repo = new FakeOAuthClientRepository();
  const clock = new Clock();
  const { metrics, counters } = oauthMetrics();
  const fetcher = new CimdFetcher(
    egress as unknown as EgressHttpClient,
    repo as unknown as OAuthClientRepository,
    rateLimiter(redis, clock),
    fakeCache(redis),
    metrics,
    config,
    clock.now,
  );
  const serve = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
    egress.respondWith((request) => ({
      ...response(typeof body === 'string' ? body : JSON.stringify(body), headers, status),
      url: request.url,
    }));
  const fetched = (result: string) => counterValue(counters, 'cimd_fetch', result);
  return { egress, redis, repo, clock, fetcher, serve, fetched };
}

describe('CimdFetcher (§6.3.7)', () => {
  describe('the request', () => {
    it('is a GET through EgressHttpClient, public addresses only, no redirects, 5 s, 16 KB', async () => {
      const { egress, fetcher, serve } = setup();
      serve(document());

      await fetcher.fetch(URL_A, IP);

      const request = egress.lastRequest!;
      expect(request.url).toBe(URL_A);
      expect(request.method).toBe('GET');
      expect(request.headers).toEqual({ accept: 'application/json' });
      expect(request.body).toBeUndefined();
      expect(request.policy?.trust).toBe(EgressTrust.PUBLIC_ONLY);
      expect(request.policy?.allowedProtocols).toEqual(['https:']);
      // Third-party-chosen URL: leaves through the egress relay, never from this server's IP.
      expect(request.policy?.relay).toBe(true);
      expect(request.policy?.limits).toMatchObject({
        maxRedirects: 0,
        totalTimeoutMs: 5000,
        maxResponseBytes: 16384,
      });
      expect(request.policy!.limits.headersTimeoutMs).toBeLessThanOrEqual(5000);
      expect(request.policy!.limits.bodyTimeoutMs).toBeLessThanOrEqual(5000);
    });

    it('sends no cookie and no Authorization header', async () => {
      const { egress, fetcher, serve } = setup();
      serve(document());
      await fetcher.fetch(URL_A, IP);
      const names = Object.keys(egress.lastRequest!.headers ?? {}).map((name) =>
        name.toLowerCase(),
      );
      expect(names).not.toContain('cookie');
      expect(names).not.toContain('authorization');
    });
  });

  describe('a valid document', () => {
    it('is stored as a CIMD row with the known members only', async () => {
      const { fetcher, serve, repo, fetched } = setup();
      serve(document(URL_A, { logo_uri: 'https://app.example.com/logo.png', extra: 1 }));

      const result = await fetcher.fetch(URL_A, IP);

      expect(result.ok).toBe(true);
      const row = repo.rows.get(URL_A)!;
      expect(row.kind).toBe(OAuthClientKind.CIMD);
      expect(row.clientName).toBe('Example App');
      expect(row.redirectUris).toEqual(['http://127.0.0.1/callback', CHATGPT_REDIRECT]);
      expect(row.metadata).not.toHaveProperty('logo_uri');
      expect(row.metadata).not.toHaveProperty('extra');
      expect(await fetched('ok')).toBe(1);
    });

    it('sanitises the client name', async () => {
      const { fetcher, serve, repo } = setup();
      serve(document(URL_A, { client_name: '  Example‮ App\u0007 ' }));
      await fetcher.fetch(URL_A, IP);
      expect(repo.rows.get(URL_A)!.clientName).toBe('Example App');
    });

    it('is reused from the cache without a fetch until cache_until', async () => {
      const { egress, fetcher, serve, clock } = setup();
      serve(document());
      await fetcher.fetch(URL_A, IP);
      clock.advance(3599);
      expect((await fetcher.fetch(URL_A, IP)).ok).toBe(true);
      expect(egress.requests).toHaveLength(1);
      clock.advance(2);
      await fetcher.fetch(URL_A, IP);
      expect(egress.requests).toHaveLength(2);
    });
  });

  describe('caching', () => {
    const cachedFor = async (cacheControl: string | undefined) => {
      const { fetcher, serve, repo, clock } = setup();
      serve(document(), cacheControl ? { 'cache-control': cacheControl } : {});
      await fetcher.fetch(URL_A, IP);
      return (repo.rows.get(URL_A)!.cacheUntil!.getTime() - clock.ms) / 1000;
    };

    it('max-age absent → 3600 s', async () => {
      expect(await cachedFor(undefined)).toBe(3600);
    });

    it('max-age 1200 → 1200 s', async () => {
      expect(await cachedFor('public, max-age=1200')).toBe(1200);
    });

    it('max-age 10 clamps to 300', async () => {
      expect(await cachedFor('max-age=10')).toBe(300);
    });

    it('max-age 999999 clamps to 86400', async () => {
      expect(await cachedFor('max-age=999999')).toBe(86_400);
    });

    it('failure cached 60 s', async () => {
      const { egress, fetcher, serve, clock, redis } = setup();
      serve('not json');
      expect(await fetcher.fetch(URL_A, IP)).toEqual({ ok: false, reason: 'invalid' });
      serve(document());

      clock.advance(59);
      expect(await fetcher.fetch(URL_A, IP)).toEqual({ ok: false, reason: 'invalid' });
      expect(egress.requests).toHaveLength(1);

      const [failure] = redis.keys('oauth:cimd:fail:');
      expect(redis.expiries.get(failure)).toBe(60_000);
      expect(failure).not.toContain(URL_A);
      redis.expire(failure);
      expect((await fetcher.fetch(URL_A, IP)).ok).toBe(true);
      expect(egress.requests).toHaveLength(2);
    });

    it('no stale-on-error: an expired row is not served when the refetch fails', async () => {
      const { fetcher, serve, clock } = setup();
      serve(document());
      await fetcher.fetch(URL_A, IP);
      clock.advance(3601);
      serve('', {}, 500);
      expect(await fetcher.fetch(URL_A, IP)).toEqual({ ok: false, reason: 'invalid' });
    });
  });

  describe('an invalid document → client_metadata_invalid', () => {
    const refused = async (body: unknown, status = 200) => {
      const { fetcher, serve, repo, fetched } = setup();
      serve(body, {}, status);
      const result = await fetcher.fetch(URL_A, IP);
      expect(result).toEqual({ ok: false, reason: 'invalid' });
      expect(repo.rows.has(URL_A)).toBe(false);
      return fetched;
    };

    it('client_id byte mismatch → client_metadata_invalid', async () => {
      await refused(document(URL_A, { client_id: 'https://app.example.com/oauth/client.json/' }));
      await refused(document(URL_A, { client_id: 'https://APP.example.com/oauth/client.json' }));
      await refused(document(URL_A, { client_id: undefined }));
    });

    it('token_endpoint_auth_method private_key_jwt → invalid', async () => {
      const fetched = await refused(
        document(URL_A, { token_endpoint_auth_method: 'private_key_jwt' }),
      );
      expect(await fetched('invalid')).toBe(1);
    });

    it('has client_secret → invalid', async () => {
      await refused(document(URL_A, { client_secret: 'x' }));
      await refused(document(URL_A, { client_secret_expires_at: 0 }));
    });

    it('redirect_uris 0 or 11 → invalid', async () => {
      await refused(document(URL_A, { redirect_uris: [] }));
      await refused(
        document(URL_A, {
          redirect_uris: Array.from({ length: 11 }, (_, i) => `http://127.0.0.1/cb${i}`),
        }),
      );
    });

    it('a redirect URI outside §6.3.9 → invalid', async () => {
      await refused(document(URL_A, { redirect_uris: ['https://evil.example.net/cb'] }));
      await refused(
        document(URL_A, { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
      );
    });

    it('non-JSON → invalid', async () => {
      await refused('<html>hello</html>');
      await refused('[1,2]');
      await refused('null');
    });

    it('a name that sanitises to nothing or is too long → invalid', async () => {
      await refused(document(URL_A, { client_name: '​‮' }));
      await refused(document(URL_A, { client_name: 'x'.repeat(65) }));
    });

    it('grant_types without authorization_code, response_types without code → invalid', async () => {
      await refused(document(URL_A, { grant_types: ['client_credentials'] }));
      await refused(document(URL_A, { response_types: ['token'] }));
    });

    it('a status other than 200 → invalid, counted as status', async () => {
      const fetched = await refused(document(), 404);
      expect(await fetched('status')).toBe(1);
    });
  });

  describe('egress failures', () => {
    it.each([
      [EgressFailureKind.BLOCKED_ADDRESS, 'blocked_address'],
      [EgressFailureKind.TIMEOUT, 'timeout'],
      [EgressFailureKind.RESPONSE_TOO_LARGE, 'too_large'],
      [EgressFailureKind.TOO_MANY_REDIRECTS, 'status'],
      [EgressFailureKind.DNS_FAILED, 'status'],
      [EgressFailureKind.CONNECTION_FAILED, 'status'],
    ])('%s → invalid, counted as %s', async (kind, label) => {
      const { egress, fetcher, fetched } = setup();
      egress.respondWith(() => {
        throw new EgressError(kind, 'refused', { url: URL_A });
      });
      expect(await fetcher.fetch(URL_A, IP)).toEqual({ ok: false, reason: 'invalid' });
      expect(await fetched(label)).toBe(1);
    });
  });

  describe('budgets', () => {
    it('per-IP budget 11th in a minute → budget', async () => {
      const { egress, fetcher, serve, fetched } = setup();
      serve('', {}, 500);
      for (let i = 0; i < 10; i += 1) {
        await fetcher.fetch(`https://h${i}.example.com/client.json`, IP);
      }
      expect(await fetcher.fetch('https://h10.example.com/client.json', IP)).toEqual({
        ok: false,
        reason: 'budget',
      });
      expect(egress.requests).toHaveLength(10);
      expect(await fetched('budget')).toBe(1);
      // Another address still has its own budget.
      await fetcher.fetch('https://h11.example.com/client.json', '203.0.113.8');
      expect(egress.requests).toHaveLength(11);
    });

    it('a budget refusal is not remembered as a failure', async () => {
      const { egress, fetcher, serve, clock, redis } = setup();
      serve('', {}, 500);
      for (let i = 0; i < 10; i += 1) {
        await fetcher.fetch(`https://h${i}.example.com/client.json`, IP);
      }
      await fetcher.fetch(URL_A, IP);
      expect(redis.keys('oauth:cimd:fail:')).toHaveLength(10);
      clock.advance(60);
      serve(document());
      expect((await fetcher.fetch(URL_A, IP)).ok).toBe(true);
      expect(egress.requests).toHaveLength(11);
    });

    it('per-host budget: the 31st fetch to one host in a minute → budget', async () => {
      const { egress, fetcher, serve } = setup();
      serve('', {}, 500);
      for (let i = 0; i < 30; i += 1) {
        await fetcher.fetch(`https://app.example.com/c${i}.json`, `198.51.100.${i}`);
      }
      expect(await fetcher.fetch('https://app.example.com/c30.json', '198.51.100.200')).toEqual({
        ok: false,
        reason: 'budget',
      });
      expect(egress.requests).toHaveLength(30);
    });

    it('global budget: the 601st fetch in a minute → budget', async () => {
      const { egress, fetcher, serve } = setup();
      serve('', {}, 500);
      for (let i = 0; i < 600; i += 1) {
        await fetcher.fetch(`https://h${i}.example.com/c.json`, `10.${i >> 8}.${i & 255}.1`);
      }
      expect(await fetcher.fetch('https://last.example.com/c.json', '10.9.9.9')).toEqual({
        ok: false,
        reason: 'budget',
      });
      expect(egress.requests).toHaveLength(600);
    });

    it('fails closed: with Redis down, an unverified client is not fetched', async () => {
      const { egress, fetcher, serve, redis } = setup();
      serve(document());
      redis.down = true;
      expect(await fetcher.fetch(URL_A, IP)).toEqual({ ok: false, reason: 'budget' });
      expect(egress.requests).toHaveLength(0);
    });

    it('verified client exempt', async () => {
      const config = oauthConfig({
        verifiedClients: [
          { clientId: VERIFIED_URL, displayName: 'Verified', vendorRedirects: [CHATGPT_REDIRECT] },
        ],
      });
      const { egress, fetcher, serve, redis, clock } = setup(config);
      serve('', {}, 500);
      for (let i = 0; i < 10; i += 1) {
        await fetcher.fetch(`https://h${i}.example.com/client.json`, IP);
      }
      serve(document(VERIFIED_URL));
      expect((await fetcher.fetch(VERIFIED_URL, IP)).ok).toBe(true);
      expect(egress.requests).toHaveLength(11);

      // Exempt from budgets also when the budget counters are unreachable.
      redis.down = true;
      clock.advance(3601);
      expect((await fetcher.fetch(VERIFIED_URL, IP)).ok).toBe(true);
      expect(egress.requests).toHaveLength(12);
    });
  });

  describe('loopback documents (e2e only)', () => {
    it('http://localhost is refused unless OAUTH_ALLOW_HTTP_CIMD_LOOPBACK is on', async () => {
      const { egress, fetcher, serve } = setup();
      serve(document('http://localhost:4100/client.json'));
      expect(await fetcher.fetch('http://localhost:4100/client.json', IP)).toEqual({
        ok: false,
        reason: 'invalid',
      });
      expect(egress.requests).toHaveLength(0);
    });

    it('with the flag on, only http://localhost may reach a loopback address', async () => {
      const { egress, fetcher, serve } = setup(oauthConfig({ allowHttpCimdLoopback: true }));
      serve(document('http://localhost:4100/client.json'));
      expect((await fetcher.fetch('http://localhost:4100/client.json', IP)).ok).toBe(true);
      expect(egress.lastRequest!.policy?.trust).toBe(EgressTrust.INTERNAL_ALLOWED);
      expect(egress.lastRequest!.policy?.allowedProtocols).toEqual(['http:']);
      expect(egress.lastRequest!.policy?.limits.maxRedirects).toBe(0);

      serve(document());
      await fetcher.fetch(URL_A, IP);
      expect(egress.lastRequest!.policy?.trust).toBe(EgressTrust.PUBLIC_ONLY);
    });
  });

  it('never turns a row of another kind into a CIMD client (review M4)', async () => {
    const { fetcher, serve, repo } = setup();
    await repo.insertClient({
      clientId: URL_A,
      kind: OAuthClientKind.BUILTIN,
      clientName: 'Assay app (assay-mcp)',
      clientUri: null,
      redirectUris: ['http://127.0.0.1/callback'],
      metadata: {},
      fetchedAt: null,
      cacheUntil: null,
    });
    serve(document());
    expect(await fetcher.fetch(URL_A, IP)).toEqual({ ok: false, reason: 'invalid' });
    expect(repo.rows.get(URL_A)!.kind).toBe(OAuthClientKind.BUILTIN);
  });

  it('two concurrent resolves of one URL make one fetch', async () => {
    const { egress, fetcher, serve } = setup();
    serve(document());
    const [a, b] = await Promise.all([fetcher.fetch(URL_A, IP), fetcher.fetch(URL_A, IP)]);
    expect(a.ok && b.ok).toBe(true);
    expect(egress.requests).toHaveLength(1);
  });
});
