import * as constants from '@modules/oauth/constants/oauth.constants';

/** Spec §6.3.14 pins every value; a change here is a spec change. */
describe('OAuth TTLs and limits (spec §6.3.14)', () => {
  it.each([
    ['OAUTH_PENDING_REQUEST_TTL_SECONDS', 600],
    ['OAUTH_AUTHORIZATION_CODE_TTL_SECONDS', 60],
    ['OAUTH_ACCESS_TOKEN_TTL_SECONDS', 3600],
    ['OAUTH_REFRESH_TOKEN_TTL_SECONDS', 2_592_000],
    ['OAUTH_REFRESH_GRACE_SECONDS', 30],
    ['OAUTH_CIMD_CACHE_MIN_SECONDS', 300],
    ['OAUTH_CIMD_CACHE_MAX_SECONDS', 86_400],
    ['OAUTH_CIMD_CACHE_DEFAULT_SECONDS', 3600],
    ['OAUTH_CIMD_FAILURE_CACHE_SECONDS', 60],
    ['OAUTH_MAX_LIVE_GRANTS_PER_AGENT', 50],
    ['OAUTH_LIVE_GRANTS_WARN_AT', 45],
  ])('%s is %p', (name, value) => {
    expect((constants as Record<string, unknown>)[name]).toBe(value);
  });
});
