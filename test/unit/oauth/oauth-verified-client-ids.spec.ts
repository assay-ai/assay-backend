import { readVerifiedClientIds } from '@modules/oauth/config/oauth-verified-client-ids';

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
