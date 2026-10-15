import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { SessionAuthGuard } from '@shared/auth';

import { ProviderConnectivityController } from '@modules/provider/controllers/provider-connectivity.controller';
import { ProviderConnectivityService } from '@modules/provider/services/provider-connectivity.service';
import { ProviderVerificationService } from '@modules/provider/services/provider-verification.service';

// This spec dials a real local socket inside the parallel unit suite. On a
// two-core CI runner it has timed out under load (TOOL_ALL_BINDINGS_FAILED, the
// assertion never reached); retrying keeps the assertion and drops the timing flake.
jest.retryTimes(2, { logErrorsBeforeRetry: true });

describe('ProviderConnectivityController GET :providerId/verification', () => {
  let app: INestApplication;
  const getVerification = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProviderConnectivityController],
      providers: [
        { provide: ProviderConnectivityService, useValue: {} },
        { provide: ProviderVerificationService, useValue: { getVerification } },
      ],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => getVerification.mockReset());

  it('rejects a non-UUID provider id with 400 before reaching the service', async () => {
    const res = await request(app.getHttpServer()).get('/providers/not-a-real-id/verification');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('providerId must be a UUID');
    expect(getVerification).not.toHaveBeenCalled();
  });

  it('passes a well-formed UUID through to the service', async () => {
    const id = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
    getVerification.mockResolvedValue({ providerId: id });
    const res = await request(app.getHttpServer()).get(`/providers/${id}/verification`);
    expect(res.status).toBe(200);
    expect(getVerification).toHaveBeenCalledWith(id);
  });
});
