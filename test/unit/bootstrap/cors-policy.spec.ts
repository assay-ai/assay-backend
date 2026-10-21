import { Controller, Get, INestApplication, Module, Post, VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { buildApiCorsOptionsDelegate, isPublicReadRequest } from '@shared/security/cors-policy';

@Controller('public/not-charged')
class PublicProbeController {
  @Get()
  get(): { ok: true } {
    return { ok: true };
  }
}

@Controller('public/demo')
class PublicWriteProbeController {
  @Post('run')
  run(): { ok: true } {
    return { ok: true };
  }
}

@Controller('buyers/me')
class PrivateProbeController {
  @Get()
  get(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  controllers: [PublicProbeController, PublicWriteProbeController, PrivateProbeController],
})
class ProbeModule {}

const ALLOWED = 'https://app.example.com';

async function boot(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableCors(buildApiCorsOptionsDelegate([ALLOWED]));
  await app.init();
  return app;
}

describe('API CORS policy (audit P2-1: CDN-cached public reads)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await boot();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([undefined, ALLOWED, 'https://evil.example'])(
    'answers a public read with a fixed * and no credentials (Origin %s)',
    async (origin) => {
      const req = request(app.getHttpServer()).get('/api/v1/public/not-charged');
      const response = await (origin ? req.set('Origin', origin) : req);
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      // Nothing varies by Origin, so a CDN copy is right for every visitor.
      expect(response.headers.vary ?? '').not.toMatch(/origin/i);
      expect(response.headers['access-control-expose-headers']).toBe('Retry-After');
    },
  );

  it('answers the preflight of a public read with GET/HEAD/OPTIONS only and no credentials', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/public/not-charged')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers['access-control-allow-methods']).toBe('GET,HEAD,OPTIONS');
  });

  it('keeps the allowlist for a write under /public (POST /public/demo/run)', async () => {
    const preflight = await request(app.getHttpServer())
      .options('/api/v1/public/demo/run')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

    const allowed = await request(app.getHttpServer())
      .post('/api/v1/public/demo/run')
      .set('Origin', ALLOWED);
    expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const foreign = await request(app.getHttpServer())
      .post('/api/v1/public/demo/run')
      .set('Origin', 'https://evil.example');
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never answers * on a non-public route, with or without credentials', async () => {
    const foreign = await request(app.getHttpServer())
      .get('/api/v1/buyers/me')
      .set('Origin', 'https://evil.example');
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();

    const allowed = await request(app.getHttpServer())
      .get('/api/v1/buyers/me')
      .set('Origin', ALLOWED);
    expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(allowed.headers['access-control-expose-headers']).toContain('X-Assay-Export-Truncated');
    expect(allowed.headers['access-control-expose-headers']).toContain('Retry-After');

    const preflight = await request(app.getHttpServer())
      .options('/api/v1/buyers/me')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets the browser reuse an allowed preflight for 2 h (Authorization is not safelisted)', async () => {
    const preflight = await request(app.getHttpServer())
      .options('/api/v1/buyers/me')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    expect(preflight.headers['access-control-max-age']).toBe('7200');
  });

  it.each([
    ['GET', '/api/v1/public/not-charged', true],
    ['HEAD', '/api/v1/public/catalogue/tools?x=1', true],
    ['POST', '/api/v1/public/demo/run', false],
    ['DELETE', '/api/v1/public/not-charged', false],
    ['GET', '/api/v1/buyers/me', false],
    ['GET', '/api/v1/publicity', false],
    ['GET', '/api/v2/public/not-charged', false],
    ['GET', '/api/v1/PUBLIC/not-charged', false],
    ['GET', '/api/v1/public/../buyers/me', false],
    ['GET', '/api/v1/public/./x', false],
    ['GET', '/api/v1/public/%2e%2e/buyers/me', false],
    ['GET', '/api/v1/public/x%2fy', false],
    ['GET', '/api/v1/public//buyers/me', false],
    ['GET', '/api/v1/public/..\\buyers/me', false],
    ['GET', 'http://evil/api/v1/public/x', false],
  ])('%s %s is a public read: %s', (method, url, expected) => {
    expect(isPublicReadRequest({ method, url })).toBe(expected);
  });

  it('treats only a GET/HEAD preflight under /public as a public read', () => {
    const url = '/api/v1/public/not-charged';
    const preflight = (m?: string) =>
      isPublicReadRequest({
        method: 'OPTIONS',
        url,
        headers: m === undefined ? {} : { 'access-control-request-method': m },
      });
    expect(preflight('GET')).toBe(true);
    expect(preflight('head')).toBe(true);
    expect(preflight('POST')).toBe(false);
    expect(preflight(undefined)).toBe(false);
  });
});
