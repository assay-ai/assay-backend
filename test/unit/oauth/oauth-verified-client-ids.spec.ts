import { Logger } from '@nestjs/common';

import { loadOAuthConfig } from '@modules/oauth/config/oauth.config';
import {
  readOAuthClientTrust,
  readPaymentClients,
  readVerifiedClientIds,
  readVerifiedClients,
} from '@modules/oauth/config/oauth-verified-client-ids';

describe('readVerifiedClientIds', () => {
  it('is empty when OAUTH_VERIFIED_CLIENTS is unset or blank', () => {
    expect(readVerifiedClientIds({})).toEqual([]);
    expect(readVerifiedClientIds({ OAUTH_VERIFIED_CLIENTS: '  ' })).toEqual([]);
  });

  it('returns the listed client ids', () => {
    const env = {
      OAUTH_VERIFIED_CLIENTS: JSON.stringify([
        {
          clientId: 'https://client.example.com/oauth/client.json',
          displayName: 'Example',
          vendorRedirects: ['https://client.example.com/callback'],
        },
        { clientId: 'dcr_abcdefghijklmnopqrstuv' },
      ]),
    };
    expect(readVerifiedClientIds(env)).toEqual([
      'https://client.example.com/oauth/client.json',
      'dcr_abcdefghijklmnopqrstuv',
    ]);
  });

  it.each([
    ['not JSON', '{'],
    ['not an array', '{"clientId":"x"}'],
    ['an entry without a clientId', '[{"displayName":"x"}]'],
    ['a null entry', '[null]'],
    ['a blank clientId', '[{"clientId":" "}]'],
  ])('returns null for %s, so no client is deleted', (_, raw) => {
    expect(readVerifiedClientIds({ OAUTH_VERIFIED_CLIENTS: raw })).toBeNull();
  });

  it('does not take the request cookie secret out of the environment', () => {
    const env = { OAUTH_REQUEST_COOKIE_SECRET: 'present', OAUTH_VERIFIED_CLIENTS: '[]' };
    readVerifiedClientIds(env);
    expect(env.OAUTH_REQUEST_COOKIE_SECRET).toBe('present');
  });
});

const MCP = 'https://mcp.example.net';
const BUILTIN = `${MCP}/oauth/clients/assay-mcp`;
const VENDOR_REDIRECT = 'https://client.example.com/callback';
/** The vendor redirect, cleared in the allowlist as loadOAuthConfig requires. */
const ALLOWLIST = JSON.stringify([{ uri: VENDOR_REDIRECT, review: false }]);

describe('readVerifiedClients', () => {
  const entry = {
    clientId: 'https://client.example.com/oauth/client.json',
    displayName: 'Example',
    vendorRedirects: [VENDOR_REDIRECT],
  };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  function read(raw: string | undefined, allowlist: string | undefined = ALLOWLIST) {
    return readVerifiedClients(
      { OAUTH_VERIFIED_CLIENTS: raw, OAUTH_REDIRECT_ALLOWLIST: allowlist },
      MCP,
    );
  }

  it('is empty when OAUTH_VERIFIED_CLIENTS is unset or blank', () => {
    expect(read(undefined)).toEqual([]);
    expect(read(' ')).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns each entry with its display name and vendor redirects', () => {
    expect(read(JSON.stringify([entry]))).toEqual([entry]);
  });

  it.each([
    ['not JSON', '{', ALLOWLIST],
    ['not an array', JSON.stringify(entry), ALLOWLIST],
    ['a null entry', '[null]', ALLOWLIST],
    ['no displayName', JSON.stringify([{ ...entry, displayName: '' }]), ALLOWLIST],
    ['no vendorRedirects', JSON.stringify([{ ...entry, vendorRedirects: [] }]), ALLOWLIST],
    ['a non-string redirect', JSON.stringify([{ ...entry, vendorRedirects: [1] }]), ALLOWLIST],
    [
      'a DCR clientId',
      JSON.stringify([{ ...entry, clientId: 'dcr_abcdefghijklmnopqrstuv' }]),
      ALLOWLIST,
    ],
    ['the built-in clientId', JSON.stringify([{ ...entry, clientId: BUILTIN }]), ALLOWLIST],
    // The checks loadOAuthConfig makes that the old reader skipped.
    [
      'a vendor redirect not in the allowlist',
      JSON.stringify([entry]),
      JSON.stringify([{ uri: 'https://other.example.org/callback', review: false }]),
    ],
    [
      'a vendor redirect still under review',
      JSON.stringify([entry]),
      JSON.stringify([{ uri: VENDOR_REDIRECT, review: true }]),
    ],
    ['an invalid allowlist', JSON.stringify([entry]), '{'],
  ])('returns null for %s, logged, so no client is shown as verified', (_, raw, allowlist) => {
    expect(read(raw, allowlist)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/OAUTH_VERIFIED_CLIENTS is invalid/);
  });

  it('accepts exactly what loadOAuthConfig accepts (one parser)', () => {
    const env = {
      NODE_ENV: 'test',
      AUTH_SESSION_SOURCE: 'both',
      MCP_PUBLIC_URL: MCP,
      WEB_APP_URL: 'https://app.example.com',
      OAUTH_VERIFIED_CLIENTS: JSON.stringify([entry]),
      OAUTH_REDIRECT_ALLOWLIST: ALLOWLIST,
    };
    expect(read(env.OAUTH_VERIFIED_CLIENTS)).toEqual(loadOAuthConfig(env, 'api').verifiedClients);
  });
});

describe('readPaymentClients', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('defaults to the built-in client, as loadOAuthConfig', () => {
    expect(readPaymentClients({}, MCP)).toEqual([BUILTIN]);
  });

  it.each([
    ['a hosted connector', ['https://claude.ai/oauth/client.json']],
    ['a DCR client', ['dcr_abcdefghijklmnopqrstuv']],
    ["another deployment's built-in client", ['https://mcp.other.example/oauth/clients/assay-mcp']],
  ])('returns null for %s (H2), logged, so no client is a payment client', (_, clients) => {
    expect(readPaymentClients({ OAUTH_PAYMENT_CLIENTS: JSON.stringify(clients) }, MCP)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/OAUTH_PAYMENT_CLIENTS is invalid/);
  });
});

describe('readOAuthClientTrust', () => {
  it('fails closed: invalid values read as no verified and no payment client', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect(
        readOAuthClientTrust({ OAUTH_VERIFIED_CLIENTS: '{', OAUTH_PAYMENT_CLIENTS: '{' }, MCP),
      ).toEqual({ paymentClients: [], verifiedClients: [] });
    } finally {
      warn.mockRestore();
    }
  });

  it('the credentials list and delegate binding answer paymentClient from one list', () => {
    const env = {
      NODE_ENV: 'test',
      AUTH_SESSION_SOURCE: 'both',
      MCP_PUBLIC_URL: MCP,
      WEB_APP_URL: 'https://app.example.com',
    };
    const trust = readOAuthClientTrust(env, MCP);
    expect(trust.paymentClients).toEqual(loadOAuthConfig(env, 'api').paymentClients);
  });
});
