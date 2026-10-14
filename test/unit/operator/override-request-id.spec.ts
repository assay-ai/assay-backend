import { lastValueFrom, of } from 'rxjs';

import { OperatorProvidersController } from '@modules/operator/controllers/operator-providers.controller';
import { LoggingInterceptor } from '@shared/interceptors/logging.interceptor';
import { RequestContext } from '@shared/observability';

/**
 * The override row's request id is minted by the server (review L-7). Before,
 * it was the caller's `x-request-id`, so a client could point an override
 * entry at any trace it liked.
 */
describe('override log request id', () => {
  function httpContext(headers: Record<string, string>) {
    const request = { method: 'POST', url: '/operator/x', ip: '127.0.0.1', headers };
    (request as Record<string, unknown>).get = () => '';
    return {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 201 }) }),
    } as never;
  }

  it('the interceptor mints a server id beside the caller-supplied one', async () => {
    const interceptor = new LoggingInterceptor();
    const seen = await lastValueFrom(
      interceptor.intercept(httpContext({ 'x-request-id': 'client-chosen' }), {
        handle: () => of(RequestContext.get()),
      }),
    );

    expect(seen?.requestId).toBe('client-chosen');
    expect(seen?.serverRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen?.serverRequestId).not.toBe('client-chosen');
  });

  it('the controller passes the server id, not the header, to the override', async () => {
    const setVerification = jest.fn().mockResolvedValue({});
    const controller = new OperatorProvidersController({ setVerification } as never);

    await RequestContext.run(
      { requestId: 'client-chosen', organizationId: null, serverRequestId: 'server-minted' },
      () =>
        controller.setVerification(
          { operatorId: 'op-1' } as never,
          '00000000-0000-4000-8000-000000000001',
          {} as never,
        ),
    );

    expect(setVerification).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'server-minted',
    );
  });
});
