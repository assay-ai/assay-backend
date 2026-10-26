import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { OperatorAuthGuard } from '@shared/auth';
import { OPERATOR_REQUEST_KEY } from '@shared/auth/operator-request.key';
import { CacheHeaderInterceptor } from '@shared/interceptors/cache-header.interceptor';

import { ObservabilityDashboardController } from '@modules/observability/controllers/observability-dashboard.controller';
import { MetricsCollectorService } from '@modules/observability/services/metrics-collector.service';

/**
 * `GET /operator/dashboard` and its JSON twin are operator-only numbers, so
 * neither may be kept by the browser (BUG-PROD-OPS-CORE-04).
 *
 * Run through the REAL `CacheHeaderInterceptor`, installed the way
 * `bootstrap/api/main.ts` installs it: Nest writes a `@Header(...)` before the
 * interceptor runs, and the interceptor's default for an undecorated GET then
 * replaced `no-store` with `private, no-cache`.
 */
describe('ObservabilityDashboardController cache headers', () => {
  let app: INestApplication;

  const signedIn: CanActivate = {
    canActivate: (context: ExecutionContext) => {
      context.switchToHttp().getRequest()[OPERATOR_REQUEST_KEY] = { displayName: 'Owner' };
      return true;
    },
  };

  beforeAll(async () => {
    const snapshot = jest.fn();
    const moduleRef = await Test.createTestingModule({
      controllers: [ObservabilityDashboardController],
      providers: [{ provide: MetricsCollectorService, useValue: { snapshot } }],
    })
      .overrideGuard(OperatorAuthGuard)
      .useValue(signedIn)
      .compile();
    // The renderer is covered by its own spec; only the headers matter here.
    jest
      .spyOn(
        await import('@modules/observability/services/dashboard-html.renderer'),
        'renderDashboardHtml',
      )
      .mockReturnValue('<html></html>');
    snapshot.mockResolvedValue({});
    app = moduleRef.createNestApplication();
    app.useGlobalInterceptors(new CacheHeaderInterceptor(new Reflector(), new ConfigService()));
    await app.init();
  });

  afterAll(async () => app.close());

  it.each(['/operator/dashboard', '/operator/dashboard/data.json'])(
    '%s is sent no-store',
    async (path) => {
      const response = await request(app.getHttpServer()).get(path);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers['cdn-cache-control']).toBe('no-store');
    },
  );
});
