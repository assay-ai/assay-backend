import { resetEnvSigningKeyCacheForTests } from '@modules/verification/signing/backends/env-key-source';
import {
  DEFAULT_OAUTH_REDIRECT_ALLOWLIST,
  OAUTH_REQUEST_COOKIE_SECRET_ENV,
  loadOAuthConfig,
} from '@modules/oauth/config/oauth.config';

const SECRET = 'ab'.repeat(32);

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    AUTH_SESSION_SOURCE: 'both',
    MCP_PUBLIC_URL: 'https://mcp.example.com',
    WEB_APP_URL: 'https://app.example.com',
    [OAUTH_REQUEST_COOKIE_SECRET_ENV]: SECRET,
    ...overrides,
  };
}

describe('loadOAuthConfig', () => {
  beforeEach(() => resetEnvSigningKeyCacheForTests());
  afterAll(() => resetEnvSigningKeyCacheForTests());

  it('loads the defaults', () => {
    const config = loadOAuthConfig(env());

    expect(config.issuer).toBe('https://mcp.example.com');
    expect(config.webAppUrl).toBe('https://app.example.com');
    expect(config.verifiedClients).toEqual([]);
    expect(config.redirectAllowlist).toEqual(DEFAULT_OAUTH_REDIRECT_ALLOWLIST);
    expect(config.allowHttpCimdLoopback).toBe(false);
    expect(config.requestCookieSecret.toString('hex')).toBe(SECRET);
  });

  it('defaults OAUTH_PAYMENT_CLIENTS to {MCP}/oauth/clients/assay-mcp', () => {
    expect(loadOAuthConfig(env()).paymentClients).toEqual([
      'https://mcp.example.com/oauth/clients/assay-mcp',
    ]);
  });

  it('reads OAUTH_PAYMENT_CLIENTS as a JSON string array', () => {
    const config = loadOAuthConfig(
      env({ OAUTH_PAYMENT_CLIENTS: JSON.stringify(['https://a.example.com/client']) }),
    );
    expect(config.paymentClients).toEqual(['https://a.example.com/client']);
    expect(() => loadOAuthConfig(env({ OAUTH_PAYMENT_CLIENTS: '{"a":1}' }))).toThrow(
      /OAUTH_PAYMENT_CLIENTS/,
    );
  });

  it('keeps the unconfirmed default redirects under review', () => {
    const review = (uri: string) =>
      DEFAULT_OAUTH_REDIRECT_ALLOWLIST.find((entry) => entry.uri === uri)?.review;

    expect(review('https://chatgpt.com/connector_platform_oauth_redirect')).toBe(false);
    expect(review('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(review('https://claude.com/api/mcp/auth_callback')).toBe(true);
    expect(review('https://vscode.dev/redirect')).toBe(true);
    const cursor = DEFAULT_OAUTH_REDIRECT_ALLOWLIST.find((entry) =>
      entry.uri.startsWith('cursor:'),
    );
    expect(cursor?.review).toBe(true);
  });

  it('rejects a wildcard redirect', () => {
    const allowlist = JSON.stringify([{ uri: 'https://*.example.com/callback', review: false }]);
    expect(() => loadOAuthConfig(env({ OAUTH_REDIRECT_ALLOWLIST: allowlist }))).toThrow(
      /OAUTH_REDIRECT_ALLOWLIST/,
    );
  });

  it.each([
    ['a query', 'https://example.com/callback?x=1'],
    ['a fragment', 'https://example.com/callback#x'],
    ['plain http', 'http://example.com/callback'],
    ['userinfo', 'https://user@example.com/callback'],
    ['a dangerous scheme', 'javascript:alert(1)'],
    ['no URI at all', 'not a uri'],
  ])('rejects a redirect with %s', (_label, uri) => {
    const allowlist = JSON.stringify([{ uri, review: false }]);
    expect(() => loadOAuthConfig(env({ OAUTH_REDIRECT_ALLOWLIST: allowlist }))).toThrow(
      /OAUTH_REDIRECT_ALLOWLIST/,
    );
  });

  it('rejects an allowlist entry without a boolean review', () => {
    const allowlist = JSON.stringify([{ uri: 'https://example.com/callback' }]);
    expect(() => loadOAuthConfig(env({ OAUTH_REDIRECT_ALLOWLIST: allowlist }))).toThrow(
      /OAUTH_REDIRECT_ALLOWLIST/,
    );
  });

  it('accepts an exact https and a private-use scheme redirect', () => {
    const entries = [
      { uri: 'https://example.com/callback', review: false },
      { uri: 'com.example.app:/oauth/callback', review: false },
    ];
    const config = loadOAuthConfig(env({ OAUTH_REDIRECT_ALLOWLIST: JSON.stringify(entries) }));
    expect(config.redirectAllowlist).toEqual(entries);
  });

  it('accepts a verified client whose vendor redirects are cleared', () => {
    const clients = [
      {
        clientId: 'https://chatgpt.com/client.json',
        displayName: 'ChatGPT',
        vendorRedirects: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      },
    ];
    const config = loadOAuthConfig(env({ OAUTH_VERIFIED_CLIENTS: JSON.stringify(clients) }));
    expect(config.verifiedClients).toEqual(clients);
  });

  it('rejects a verified client whose vendor redirect is review:true', () => {
    const clients = [
      {
        clientId: 'https://claude.ai/client.json',
        displayName: 'Claude',
        vendorRedirects: ['https://claude.ai/api/mcp/auth_callback'],
      },
    ];
    expect(() => loadOAuthConfig(env({ OAUTH_VERIFIED_CLIENTS: JSON.stringify(clients) }))).toThrow(
      /OAUTH_VERIFIED_CLIENTS/,
    );
  });

  it('rejects a verified client whose vendor redirect is not allowlisted', () => {
    const clients = [
      {
        clientId: 'https://example.com/client.json',
        displayName: 'Example',
        vendorRedirects: ['https://example.com/callback'],
      },
    ];
    expect(() => loadOAuthConfig(env({ OAUTH_VERIFIED_CLIENTS: JSON.stringify(clients) }))).toThrow(
      /OAUTH_VERIFIED_CLIENTS/,
    );
  });

  it('rejects malformed OAUTH_VERIFIED_CLIENTS', () => {
    expect(() => loadOAuthConfig(env({ OAUTH_VERIFIED_CLIENTS: 'not json' }))).toThrow(
      /OAUTH_VERIFIED_CLIENTS/,
    );
    expect(() =>
      loadOAuthConfig(env({ OAUTH_VERIFIED_CLIENTS: JSON.stringify([{ clientId: 'x' }]) })),
    ).toThrow(/OAUTH_VERIFIED_CLIENTS/);
  });

  it('refuses HTTP CIMD loopback in production', () => {
    expect(() =>
      loadOAuthConfig(env({ NODE_ENV: 'production', OAUTH_ALLOW_HTTP_CIMD_LOOPBACK: 'true' })),
    ).toThrow(/OAUTH_ALLOW_HTTP_CIMD_LOOPBACK/);
  });

  it('allows HTTP CIMD loopback outside production', () => {
    expect(
      loadOAuthConfig(env({ OAUTH_ALLOW_HTTP_CIMD_LOOPBACK: 'true' })).allowHttpCimdLoopback,
    ).toBe(true);
    expect(() => loadOAuthConfig(env({ OAUTH_ALLOW_HTTP_CIMD_LOOPBACK: 'yes' }))).toThrow(
      /OAUTH_ALLOW_HTTP_CIMD_LOOPBACK/,
    );
  });

  it.each([undefined, 'config', 'privy', 'db'])(
    'refuses to load without both (AUTH_SESSION_SOURCE=%s)',
    (mode) => {
      expect(() => loadOAuthConfig(env({ AUTH_SESSION_SOURCE: mode }))).toThrow(
        /AUTH_SESSION_SOURCE/,
      );
    },
  );

  it.each([
    ['MCP_PUBLIC_URL', { MCP_PUBLIC_URL: 'http://mcp.example.com' }],
    ['WEB_APP_URL', { WEB_APP_URL: 'http://app.example.com' }],
  ])('refuses a non-https %s in production', (name, overrides) => {
    expect(() => loadOAuthConfig(env({ NODE_ENV: 'production', ...overrides }))).toThrow(
      new RegExp(name),
    );
  });

  it('allows http hosts outside production (the local stack)', () => {
    const config = loadOAuthConfig(
      env({ MCP_PUBLIC_URL: 'http://localhost:3200', WEB_APP_URL: 'http://localhost:4000' }),
    );
    expect(config.paymentClients).toEqual(['http://localhost:3200/oauth/clients/assay-mcp']);
  });

  describe(OAUTH_REQUEST_COOKIE_SECRET_ENV, () => {
    it('is required', () => {
      expect(() => loadOAuthConfig(env({ [OAUTH_REQUEST_COOKIE_SECRET_ENV]: undefined }))).toThrow(
        new RegExp(OAUTH_REQUEST_COOKIE_SECRET_ENV),
      );
    });

    it('needs at least 32 bytes of hex, and never quotes the value', () => {
      const short = 'cd'.repeat(31);
      let message = '';
      try {
        loadOAuthConfig(env({ [OAUTH_REQUEST_COOKIE_SECRET_ENV]: short }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(new RegExp(OAUTH_REQUEST_COOKIE_SECRET_ENV));
      expect(message).not.toContain(short);
    });

    it('is deleted from the environment once read, even when the load fails', () => {
      const ok = env();
      loadOAuthConfig(ok);
      expect(ok[OAUTH_REQUEST_COOKIE_SECRET_ENV]).toBeUndefined();

      resetEnvSigningKeyCacheForTests();
      const bad = env({ AUTH_SESSION_SOURCE: 'config' });
      expect(() => loadOAuthConfig(bad)).toThrow();
      expect(bad[OAUTH_REQUEST_COOKIE_SECRET_ENV]).toBeUndefined();
    });

    it('is read once per process, so a second loader (SERVICE_TYPE=all) gets the same key', () => {
      const first = loadOAuthConfig(env());
      const second = loadOAuthConfig(env({ [OAUTH_REQUEST_COOKIE_SECRET_ENV]: undefined }));
      expect(second.requestCookieSecret.equals(first.requestCookieSecret)).toBe(true);
    });
  });
});
