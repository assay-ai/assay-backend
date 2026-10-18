import { Logger, NotFoundException } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';

import { LoggingInterceptor } from '@shared/interceptors/logging.interceptor';

/**
 * R-OA-27: the request line names the path with the consent request id and
 * any OAuth secret in the query replaced, and never the headers or the body.
 */
describe('LoggingInterceptor redaction', () => {
  const RID = 'cmlkLXZhbHVlLXRoYXQtbXVzdC1uZXZlci1sZWFrLTEyMzQ';
  const BEARER = 'assay_at_' + 'B'.repeat(43);
  const REFRESH = 'assay_rt_' + 'F'.repeat(43);

  function httpContext(url: string) {
    const request = {
      method: 'POST',
      url,
      originalUrl: url,
      ip: '127.0.0.1',
      headers: {
        authorization: `Bearer ${BEARER}`,
        cookie: `__Host-assay_oar=${'c'.repeat(64)}`,
      },
      body: { grant_type: 'refresh_token', refresh_token: REFRESH },
      get: () => '',
    };
    return {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
    } as never;
  }

  async function logged(url: string, fail = false): Promise<unknown[][]> {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await lastValueFrom(
        new LoggingInterceptor().intercept(httpContext(url), {
          handle: () => (fail ? throwError(() => new NotFoundException()) : of('ok')),
        }),
      ).catch(() => undefined);
      return [...log.mock.calls, ...error.mock.calls];
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  }

  it.each([
    [`/api/v1/oauth/requests/${RID}`, '/api/v1/oauth/requests/[REDACTED]'],
    [`/api/v1/oauth/requests/${RID}/approve`, '/api/v1/oauth/requests/[REDACTED]/approve'],
    [`/oauth/authorize/continue?request=${RID}`, '/oauth/authorize/continue'],
  ])('logs %s with the rid redacted, on success and on error', async (url, expected) => {
    for (const fail of [false, true]) {
      const calls = await logged(url, fail);
      expect(calls).toHaveLength(1);
      expect((calls[0][0] as { url: string }).url).toBe(expected);
      expect(JSON.stringify(calls)).not.toContain(RID);
    }
  });

  it('never logs the Authorization header, the cookie or the token form body', async () => {
    for (const url of ['/oauth/token', '/oauth/revoke', `/oauth/token?refresh_token=${REFRESH}`]) {
      const text = JSON.stringify(await logged(url));
      expect(text).not.toContain(BEARER);
      expect(text).not.toContain(REFRESH);
      expect(text).not.toContain('c'.repeat(64));
    }
  });
});
