import {
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

describe('readVerifiedClients', () => {
  const entry = {
    clientId: 'https://client.example.com/oauth/client.json',
    displayName: 'Example',
    vendorRedirects: ['https://client.example.com/callback'],
  };

  it('is empty when OAUTH_VERIFIED_CLIENTS is unset or blank', () => {
    expect(readVerifiedClients({})).toEqual([]);
    expect(readVerifiedClients({ OAUTH_VERIFIED_CLIENTS: ' ' })).toEqual([]);
  });

  it('returns each entry with its display name and vendor redirects', () => {
    expect(readVerifiedClients({ OAUTH_VERIFIED_CLIENTS: JSON.stringify([entry]) })).toEqual([
      entry,
    ]);
  });

  it.each([
    ['not JSON', '{'],
    ['not an array', JSON.stringify(entry)],
    ['a null entry', '[null]'],
    ['no displayName', JSON.stringify([{ ...entry, displayName: '' }])],
    ['no vendorRedirects', JSON.stringify([{ ...entry, vendorRedirects: [] }])],
    ['a non-string redirect', JSON.stringify([{ ...entry, vendorRedirects: [1] }])],
    [
      'a non-https clientId',
      JSON.stringify([{ ...entry, clientId: 'dcr_abcdefghijklmnopqrstuv' }]),
    ],
  ])('returns null for %s, so no client is shown as verified', (_, raw) => {
    expect(readVerifiedClients({ OAUTH_VERIFIED_CLIENTS: raw })).toBeNull();
  });
});
