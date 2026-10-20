import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { SESSION_REQUEST_KEY, SessionAuthGuard } from '@shared/auth';

import { ProviderConnectivityController } from '@modules/provider/controllers/provider-connectivity.controller';
import { ProviderConnectivityService } from '@modules/provider/services/provider-connectivity.service';
import { ProviderVerificationService } from '@modules/provider/services/provider-verification.service';

describe('ProviderConnectivityController GET :providerId/verification', () => {
  let app: INestApplication;
  const getVerificationFor = jest.fn();
  const CALLER_ORG = 'a1b2c3d4-0000-4000-8000-000000000001';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProviderConnectivityController],
      providers: [
        { provide: ProviderConnectivityService, useValue: {} },
        { provide: ProviderVerificationService, useValue: { getVerificationFor } },
      ],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({
        canActivate: (context: import('@nestjs/common').ExecutionContext) => {
          const req = context.switchToHttp().getRequest<Record<string, unknown>>();
          req[SESSION_REQUEST_KEY] = { organizationId: CALLER_ORG };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
    // Compiling a Nest module inside the parallel suite has taken longer than the
    // default 5 s on a two-core CI runner, which failed both tests below.
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => getVerificationFor.mockReset());

  it('rejects a non-UUID provider id with 400 before reaching the service', async () => {
    const res = await request(app.getHttpServer()).get('/providers/not-a-real-id/verification');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('providerId must be a UUID');
    expect(getVerificationFor).not.toHaveBeenCalled();
  });

  it("passes a well-formed UUID through to the service, scoped to the caller's organization", async () => {
    const id = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
    getVerificationFor.mockResolvedValue({ providerId: id });
    const res = await request(app.getHttpServer()).get(`/providers/${id}/verification`);
    expect(res.status).toBe(200);
    expect(getVerificationFor).toHaveBeenCalledWith(CALLER_ORG, id);
  });
});

describe('ProviderConnectivityController routes', () => {
  it('exposes no egress-ips route', () => {
    const proto = ProviderConnectivityController.prototype as unknown as Record<string, unknown>;
    expect(proto.getEgressIps).toBeUndefined();
  });
});
