import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import request from 'supertest';

import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { PublicReadRateLimitInterceptor } from '@shared/interceptors/public-read-rate-limit.interceptor';

import { CatalogueController } from '@modules/catalogue/controllers/catalogue.controller';
import { PublicCatalogueController } from '@modules/catalogue/controllers/public-catalogue.controller';
import { PublicNotChargedController } from '@modules/catalogue/controllers/public-not-charged.controller';
import { PublicFeaturesController } from '@bootstrap/api/public-features.controller';
import { PublicDemoController } from '@modules/mcp/controllers/public-demo.controller';
import { PublicReservesController } from '@modules/settlement/controllers/public-reserves.controller';
import { PublicToolsetsController } from '@modules/toolset/controllers/public-toolsets.controller';
import { PublicCatalogueService } from '@modules/catalogue/services/public-catalogue.service';
import { PublicNotChargedService } from '@modules/catalogue/services/public-not-charged.service';

/**
 * The public Explorer routes answer a request that carries no credential at
 * all, and answer it from the same service the guarded `/catalogue/*` uses.
 *
 * Booted over real HTTP with no guard overridden: if either controller ever
 * picks up `SessionAuthGuard`, Nest fails to resolve its dependencies here or
 * the request 401s/403s, and both are a red test.
 */
describe('public Explorer routes need no authentication', () => {
  let app: INestApplication;

  const PROVIDER_ID = '5b1d2a0e-7c4f-4e8a-9f61-0a2b3c4d5e6f';
  const catalogue = {
    listProviders: jest.fn(async () => ({ providers: [] })),
    listTools: jest.fn(async () => ({ tools: [] })),
    getProvider: jest.fn(async (providerId: string) => ({ providerId, tools: [] })),
  };
  const notCharged = {
    read: jest.fn(async () => ({
      windowDays: 30,
      since: '2026-09-15T00:00:00.000Z',
      until: '2026-10-15T00:00:00.000Z',
      minBuyers: 5,
      withheldForPrivacy: false,
      totals: { callsChecked: 0, callsNotCharged: 0, callsFailedCheck: 0, amountNotCharged: [] },
      recent: [],
    })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicCatalogueController, PublicNotChargedController],
      providers: [
        { provide: PublicCatalogueService, useValue: catalogue },
        { provide: PublicNotChargedService, useValue: notCharged },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // As `bootstrapApi` wires them: the one global filter decides what an
    // error body may say.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['/public/catalogue/tools', () => catalogue.listTools],
    ['/public/catalogue/providers', () => catalogue.listProviders],
    [`/public/catalogue/providers/${PROVIDER_ID}`, () => catalogue.getProvider],
    ['/public/not-charged', () => notCharged.read],
  ])('GET %s answers 200 with no Authorization header', async (path, handler) => {
    const res = await request(app.getHttpServer()).get(path);

    expect(res.status).toBe(200);
    expect(handler()).toHaveBeenCalled();
  });

  it('passes ?category= to the service, and refuses a malformed one with 400', async () => {
    catalogue.listTools.mockClear();
    const ok = await request(app.getHttpServer()).get('/public/catalogue/tools?category=weather');
    expect(ok.status).toBe(200);
    expect(catalogue.listTools).toHaveBeenCalledWith('weather', undefined);

    const bad = await request(app.getHttpServer()).get(
      '/public/catalogue/tools?category=Not%20One',
    );
    expect(bad.status).toBe(400);
  });

  it('does not swallow /public/catalogue/tools into the provider route', async () => {
    catalogue.getProvider.mockClear();

    await request(app.getHttpServer()).get('/public/catalogue/tools').expect(200);

    expect(catalogue.getProvider).not.toHaveBeenCalled();
  });

  it('still validates the provider id', async () => {
    await request(app.getHttpServer()).get('/public/catalogue/providers/not-a-uuid').expect(400);
  });

  it('answers an internal failure without a stack trace or the error’s own text', async () => {
    notCharged.read.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.7:5432'));

    const res = await request(app.getHttpServer()).get('/public/not-charged');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.7|at .*\.ts/);
  });
});

/**
 * The signed-in `/catalogue/*` reads the same shared market as the public
 * routes, so it is throttled the same way (review 2026-10-17).
 */
describe('the signed-in catalogue is rate limited', () => {
  it.each([
    CatalogueController,
    PublicCatalogueController,
    PublicNotChargedController,
    // Every other unauthenticated route under `/public`, on the same window.
    PublicToolsetsController,
    PublicReservesController,
    PublicFeaturesController,
    PublicDemoController,
  ])('%p has PublicReadRateLimitInterceptor attached', (controller) => {
    const interceptors = (Reflect.getMetadata(INTERCEPTORS_METADATA, controller) ??
      []) as unknown[];
    expect(interceptors).toContain(PublicReadRateLimitInterceptor);
  });
});
