import { redactOAuthText, redactOAuthUrl, REDACTED } from '@shared/observability';

/**
 * R-OA-27: a consent request id (`rid`) never reaches a log or an error body.
 * It travels in two URLs the server sees — the consent API path and the
 * `continue` query — so every logged or echoed URL goes through
 * `redactOAuthUrl` first.
 */
describe('redactOAuthUrl', () => {
  const RID = 'Q2xp-ZW50X2lk_bGVhay10ZXN0LXJpZC12YWx1ZS0xMjM0NTY';

  it.each([
    [`/api/v1/oauth/requests/${RID}`, `/api/v1/oauth/requests/${REDACTED}`],
    [`/api/v1/oauth/requests/${RID}/approve`, `/api/v1/oauth/requests/${REDACTED}/approve`],
    [`/api/v1/oauth/requests/${RID}/deny`, `/api/v1/oauth/requests/${REDACTED}/deny`],
    [`/oauth/requests/${RID}`, `/oauth/requests/${REDACTED}`],
    [`/v2/oauth/requests/${RID}?x=1`, `/v2/oauth/requests/${REDACTED}`],
  ])('replaces the rid in %s, under any prefix', (url, expected) => {
    expect(redactOAuthUrl(url)).toBe(expected);
  });

  it.each([
    [`/oauth/authorize/continue?request=${RID}`, '/oauth/authorize/continue'],
    [`/oauth/authorize/continue?a=1&request=${RID}&b=2`, '/oauth/authorize/continue'],
    [
      '/oauth/authorize?response_type=code&client_id=dcr_x&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb' +
        '&state=st4te&code_challenge=ch4llenge&assay_replaces=11111111-2222-4333-8444-555555555555',
      '/oauth/authorize',
    ],
    [`/api/v1/oauth/requests/${RID}/approve?x=1`, `/api/v1/oauth/requests/${REDACTED}/approve`],
  ])('drops the whole query of %s, keeping only the path', (url, expected) => {
    expect(redactOAuthUrl(url)).toBe(expected);
  });

  it.each([
    'code',
    'code_verifier',
    'code_challenge',
    'refresh_token',
    'access_token',
    'token',
    'client_secret',
    'rid',
  ])('replaces a %s query value defensively', (key) => {
    expect(redactOAuthUrl(`/oauth/token?${key}=s3cr3t-value&grant_type=refresh_token`)).toBe(
      `/oauth/token?${key}=${REDACTED}&grant_type=refresh_token`,
    );
  });

  it('matches a percent-encoded query key', () => {
    expect(redactOAuthUrl('/x?code%5Fverifier=abc')).toBe(`/x?code%5Fverifier=${REDACTED}`);
  });

  it('replaces an assay token anywhere in the URL (the value backstop)', () => {
    const token = 'assay_at_' + 'a'.repeat(43);
    expect(redactOAuthUrl(`/anything/${token}?q=${token}`)).toBe(
      `/anything/${REDACTED}?q=${REDACTED}`,
    );
  });

  it('leaves an ordinary URL unchanged', () => {
    for (const url of [
      '/api/v1/payments/abc-123',
      '/oauth/authorize',
      '/api/v1/payments?state=s&client_id=x',
      '/oauth/requests',
      '/',
      '',
    ]) {
      expect(redactOAuthUrl(url)).toBe(url);
    }
  });

  it('is case-insensitive, as routing is (M1)', () => {
    expect(redactOAuthUrl(`/api/v1/OAuth/Requests/${RID}`)).toBe(
      `/api/v1/OAuth/Requests/${REDACTED}`,
    );
    expect(redactOAuthUrl('/OAUTH/AUTHORIZE?state=s&assay_replaces=x')).toBe('/OAUTH/AUTHORIZE');
    expect(redactOAuthUrl('/x?Refresh_Token=abc')).toBe(`/x?Refresh_Token=${REDACTED}`);
  });
});

describe('redactOAuthText', () => {
  const RID = 'Q2xp-ZW50X2lk_bGVhay10ZXN0LXJpZC12YWx1ZS0xMjM0NTY';
  const RT = 'assay_rt_' + 'R'.repeat(43);

  it.each([
    [
      `Cannot GET /api/v1/oauth/requests/${RID}/approve`,
      `Cannot GET /api/v1/oauth/requests/${REDACTED}/approve`,
    ],
    [
      `Cannot PUT /API/V1/OAUTH/REQUESTS/${RID}?x=1 now`,
      `Cannot PUT /API/V1/OAUTH/REQUESTS/${REDACTED} now`,
    ],
    [
      `Cannot POST /oauth/authorize/continue?request=${RID}`,
      'Cannot POST /oauth/authorize/continue',
    ],
    [
      `Cannot DELETE /oauth/token?refresh_token=abc&x=1`,
      `Cannot DELETE /oauth/token?refresh_token=${REDACTED}&x=1`,
    ],
    [`Failed to decode param '${RT}'`, `Failed to decode param '${REDACTED}'`],
    ['Cannot GET /api/v1/payments/abc-123', 'Cannot GET /api/v1/payments/abc-123'],
  ])('redacts %s', (text, expected) => {
    expect(redactOAuthText(text)).toBe(expected);
  });
});
