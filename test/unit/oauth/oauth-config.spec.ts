import { resetEnvSigningKeyCacheForTests } from '@modules/verification/signing/backends/env-key-source';
import {
  DEFAULT_OAUTH_REDIRECT_ALLOWLIST,
  OAUTH_REQUEST_COOKIE_SECRET_ENV,
  loadOAuthConfig,
  loadOAuthSessionConfig,
} from '@modules/oauth/config/oauth.config';

/** 32 distinct bytes, as a random key would be. */
const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 3)).toString('hex');

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

  it('accepts OAUTH_PAYMENT_CLIENTS naming the built-in client', () => {
    const builtin = 'https://mcp.example.com/oauth/clients/assay-mcp';
    const config = loadOAuthConfig(env({ OAUTH_PAYMENT_CLIENTS: JSON.stringify([builtin]) }));
    expect(config.paymentClients).toEqual([builtin]);
  });

  it.each([
    ['a hosted connector', ['https://claude.ai/oauth/client.json']],
    ['a DCR client', ['dcr_abcdefghijklmnopqrstuv']],
    ['the built-in path on another origin', ['https://evil.example.com/oauth/clients/assay-mcp']],
    [
      'the built-in client plus another',
      ['https://mcp.example.com/oauth/clients/assay-mcp', 'https://a.example.com/client'],
    ],
  ])('refuses OAUTH_PAYMENT_CLIENTS naming %s (owner decision H2)', (_label, clients) => {
    expect(() => loadOAuthConfig(env({ OAUTH_PAYMENT_CLIENTS: JSON.stringify(clients) }))).toThrow(
      /OAUTH_PAYMENT_CLIENTS/,
    );
  });

  it.each(['{"a":1}', '[]', '[1]', 'not json'])(
    'refuses a malformed OAUTH_PAYMENT_CLIENTS (%s)',
    (raw) => {
      expect(() => loadOAuthConfig(env({ OAUTH_PAYMENT_CLIENTS: raw }))).toThrow(
        /OAUTH_PAYMENT_CLIENTS/,
      );
    },
  );

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
    ['non-loopback http', 'http://example.com/callback'],
    ['loopback http on 127.0.0.1 (its own rule, port ignored)', 'http://127.0.0.1/callback'],
    ['loopback http on localhost', 'http://localhost:8080/callback'],
    ['loopback http on [::1]', 'http://[::1]:3000/callback'],
    ['userinfo', 'https://user@example.com/callback'],
    ['javascript:', 'javascript:alert(1)'],
    ['an obfuscated javascript:', 'java\tscript:alert(1)'],
    ['data:', 'data:text/html,x'],
    ['file:', 'file:///etc/passwd'],
    ['filesystem:', 'filesystem:https://example.com/temporary/x'],
    ['view-source:', 'view-source:https://example.com/'],
    ['jar:', 'jar:https://example.com/a.jar!/x'],
    ['intent:', 'intent://x'],
    ['content:', 'content://com.example.provider/x'],
    ['chrome-extension:', 'chrome-extension://abcdefghijklmnop/cb'],
    ['tel:', 'tel:+15550100'],
    ['a bare x:', 'x:'],
    ['a private-use scheme without a path', 'com.example.app:'],
    ['an upper-case https URI', 'HTTPS://EXAMPLE.COM/cb'],
    ['an explicit default port', 'https://example.com:443/cb'],
    ['a backslash in the authority', 'https://example.com\\@evil.example.com/'],
    ['no URI at all', 'not a uri'],
  ])('rejects a redirect with %s', (_label, uri) => {
    const allowlist = JSON.stringify([{ uri, review: false }]);
    expect(() => loadOAuthConfig(env({ OAUTH_REDIRECT_ALLOWLIST: allowlist }))).toThrow(
      /OAUTH_REDIRECT_ALLOWLIST/,
    );
  });

  it('rejects a URI listed twice', () => {
    const uri = 'https://example.com/callback';
    const allowlist = JSON.stringify([
      { uri, review: true },
      { uri, review: false },
    ]);
    expect(() => loadOAuthConfig(env({ OAUTH_REDIRECT_ALLOWLIST: allowlist }))).toThrow(
      /listed twice/,
    );
  });

  it('rejects an allowlist entry without a boolean review', () => {
    const allowlist = JSON.stringify([{ uri: 'https://example.com/callback' }]);
    expect(() => loadOAuthConfig(env({ OAUTH_REDIRECT_ALLOWLIST: allowlist }))).toThrow(
      /OAUTH_REDIRECT_ALLOWLIST/,
    );
  });

  it('accepts exact https and private-use scheme redirects', () => {
    const entries = [
      { uri: 'https://example.com/callback', review: false },
      { uri: 'com.example.app:/oauth/callback', review: false },
      { uri: 'cursor://anysphere.cursor-mcp/oauth/callback', review: true },
      { uri: 'vscode://example.ext/callback', review: true },
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

  it('refuses HTTP CIMD loopback on a deployment that is not local', () => {
    expect(() =>
      loadOAuthConfig(env({ NODE_ENV: 'development', OAUTH_ALLOW_HTTP_CIMD_LOOPBACK: 'true' })),
    ).toThrow(/local run only/);
    expect(
      loadOAuthConfig(
        env({
          NODE_ENV: 'development',
          MCP_PUBLIC_URL: 'http://localhost:3200',
          WEB_APP_URL: 'http://localhost:4000',
          OAUTH_ALLOW_HTTP_CIMD_LOOPBACK: 'true',
        }),
      ).allowHttpCimdLoopback,
    ).toBe(true);
  });

  it('refuses a verified client that is not a CIMD URL', () => {
    for (const clientId of [
      'dcr_' + 'A'.repeat(22),
      'https://mcp.example.com/oauth/clients/assay-mcp',
      'http://localhost:4100/client.json',
      'https://203.0.113.9/client.json',
    ]) {
      const clients = [
        {
          clientId,
          displayName: 'X',
          vendorRedirects: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        },
      ];
      expect(() =>
        loadOAuthConfig(env({ OAUTH_VERIFIED_CLIENTS: JSON.stringify(clients) })),
      ).toThrow(/must be an https CIMD client_id URL/);
    }
  });

  it('reads the DCR caps, with defaults', () => {
    expect(loadOAuthConfig(env())).toMatchObject({ dcrGlobalPerDay: 1000, dcrPer48PerHour: 50 });
    expect(
      loadOAuthConfig(env({ OAUTH_DCR_GLOBAL_PER_DAY: '200', OAUTH_DCR_PER_48_PER_HOUR: '60' })),
    ).toMatchObject({ dcrGlobalPerDay: 200, dcrPer48PerHour: 60 });
    for (const bad of ['0', '-1', '1.5', 'many']) {
      expect(() => loadOAuthConfig(env({ OAUTH_DCR_GLOBAL_PER_DAY: bad }))).toThrow(
        /OAUTH_DCR_GLOBAL_PER_DAY/,
      );
      expect(() => loadOAuthConfig(env({ OAUTH_DCR_PER_48_PER_HOUR: bad }))).toThrow(
        /OAUTH_DCR_PER_48_PER_HOUR/,
      );
    }
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

    it.each([
      ['all bytes equal', '00'.repeat(32)],
      ['two distinct bytes', 'ab'.repeat(32)],
      ['fewer than 16 distinct bytes', '000102030405060708090a0b0c0d0e'.repeat(2) + '0001'],
    ])('rejects a low-entropy value (%s)', (_label, value) => {
      expect(() => loadOAuthConfig(env({ [OAUTH_REQUEST_COOKIE_SECRET_ENV]: value }))).toThrow(
        /not random/,
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

    it('is deleted when the value itself is malformed, and a second load says required', () => {
      const bad = env({ [OAUTH_REQUEST_COOKIE_SECRET_ENV]: 'zz'.repeat(32) });
      expect(() => loadOAuthConfig(bad)).toThrow(/hex-encoded/);
      expect(bad[OAUTH_REQUEST_COOKIE_SECRET_ENV]).toBeUndefined();
      expect(() => loadOAuthConfig(bad)).toThrow(/is required/);
    });

    it('is read once per process, so a second loader (SERVICE_TYPE=all) gets the same key', () => {
      const first = loadOAuthConfig(env());
      const second = loadOAuthConfig(env({ [OAUTH_REQUEST_COOKIE_SECRET_ENV]: undefined }));
      expect(second.requestCookieSecret.equals(first.requestCookieSecret)).toBe(true);
    });
  });
});

/**
 * What the OAuth session source reads, in every process that loads
 * `AuthModule` (the scheduler included): no secret, no session-source mode.
 */
describe('loadOAuthSessionConfig', () => {
  const bare = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
    NODE_ENV: 'test',
    MCP_PUBLIC_URL: 'https://mcp.example.com',
    ...overrides,
  });

  it('needs neither the cookie secret nor AUTH_SESSION_SOURCE=both', () => {
    expect(loadOAuthSessionConfig(bare())).toEqual({
      audience: 'https://mcp.example.com',
      paymentClients: ['https://mcp.example.com/oauth/clients/assay-mcp'],
    });
  });

  it.each([
    ['the defaults', {}],
    [
      'an explicit OAUTH_PAYMENT_CLIENTS',
      {
        OAUTH_PAYMENT_CLIENTS: JSON.stringify(['https://mcp.example.com/oauth/clients/assay-mcp']),
      },
    ],
    ['an MCP_PUBLIC_URL with a trailing slash', { MCP_PUBLIC_URL: 'https://mcp.example.com/' }],
  ])(
    'agrees with loadOAuthConfig on the audience and the payment clients (%s)',
    (_label, overrides: Record<string, string>) => {
      resetEnvSigningKeyCacheForTests();
      const full = loadOAuthConfig(env(overrides));
      const session = loadOAuthSessionConfig(env(overrides));
      expect(session.audience).toBe(full.issuer);
      expect(session.paymentClients).toEqual(full.paymentClients);
      expect(full.issuer).toBe('https://mcp.example.com');
      expect(full.paymentClients).toEqual(['https://mcp.example.com/oauth/clients/assay-mcp']);
    },
  );

  it('refuses a payment client other than the built-in one (H2)', () => {
    expect(() =>
      loadOAuthSessionConfig(
        bare({ OAUTH_PAYMENT_CLIENTS: JSON.stringify(['https://app.example.com/client.json']) }),
      ),
    ).toThrow(/OAUTH_PAYMENT_CLIENTS/);
  });
});
