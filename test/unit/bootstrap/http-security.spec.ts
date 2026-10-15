import { Controller, Get, INestApplication, Module, NotFoundException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { DEV_CORS_ALLOWED_ORIGINS, parseCorsAllowedOrigins } from '@config/app.config';
import { applyHttpSecurity } from '@shared/security/security-headers';

describe('CORS_ALLOWED_ORIGINS (R17-R-02)', () => {
  it('defaults to the local dashboards on :4000-:4005 outside production', () => {
    for (const env of [undefined, 'development', 'local', 'test']) {
      const origins = parseCorsAllowedOrigins(undefined, env);
      expect(origins).toEqual([...DEV_CORS_ALLOWED_ORIGINS]);
    }
    expect(DEV_CORS_ALLOWED_ORIGINS).toContain('http://localhost:4000');
    expect(DEV_CORS_ALLOWED_ORIGINS).toContain('http://localhost:4005');
    expect(DEV_CORS_ALLOWED_ORIGINS).toContain('http://127.0.0.1:4003');
    expect(DEV_CORS_ALLOWED_ORIGINS).not.toContain('http://localhost:4006');
  });

  it('must be set in production; there is no default there', () => {
    expect(() => parseCorsAllowedOrigins(undefined, 'production')).toThrow(
      /CORS_ALLOWED_ORIGINS must be set/,
    );
    expect(() => parseCorsAllowedOrigins('  ', 'production')).toThrow(
      /CORS_ALLOWED_ORIGINS must be set/,
    );
  });

  it('takes a comma-separated list of exact origins', () => {
    expect(
      parseCorsAllowedOrigins(
        ' https://app.example.com , https://ops.example.com:8443,',
        'production',
      ),
    ).toEqual(['https://app.example.com', 'https://ops.example.com:8443']);
  });

  it.each(['*', 'https://app.example.com/', 'https://app.example.com/path', 'app.example.com'])(
    'refuses %s',
    (raw) => {
      expect(() => parseCorsAllowedOrigins(raw, 'development')).toThrow(/CORS_ALLOWED_ORIGINS/);
    },
  );
});

@Controller('probe')
class ProbeController {
  @Get()
  get(): { ok: true } {
    return { ok: true };
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException();
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

async function boot(nodeEnv: string, origins: string[]): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  applyHttpSecurity(app, nodeEnv);
  app.enableCors({ origin: origins, credentials: true });
  await app.init();
  return app;
}

describe('API security headers and CORS (R17-R-02)', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it('sends the security headers and no X-Powered-By, on success and on error', async () => {
    app = await boot('development', [...DEV_CORS_ALLOWED_ORIGINS]);

    for (const path of ['/probe', '/probe/missing', '/no-such-route']) {
      const response = await request(app.getHttpServer()).get(path);
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toBe("frame-ancestors 'none'");
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      // Plain-HTTP localhost: HSTS would pin localhost to HTTPS in the browser.
      expect(response.headers['strict-transport-security']).toBeUndefined();
    }
  });

  it('adds HSTS in production', async () => {
    app = await boot('production', ['https://app.example.com']);

    const response = await request(app.getHttpServer()).get('/probe');
    expect(response.headers['strict-transport-security']).toMatch(
      /^max-age=\d+; includeSubDomains$/,
    );
  });

  it('reflects an allowed origin with credentials, and never answers *', async () => {
    app = await boot('development', [...DEV_CORS_ALLOWED_ORIGINS]);

    const allowed = await request(app.getHttpServer())
      .get('/probe')
      .set('Origin', 'http://localhost:4003');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:4003');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const preflight = await request(app.getHttpServer())
      .options('/probe')
      .set('Origin', 'http://localhost:4000')
      .set('Access-Control-Request-Method', 'GET');
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:4000');
  });

  it('gives a foreign origin no Access-Control-Allow-Origin at all', async () => {
    app = await boot('production', ['https://app.example.com']);

    const foreign = await request(app.getHttpServer())
      .get('/probe')
      .set('Origin', 'https://evil.example');
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();

    const local = await request(app.getHttpServer())
      .get('/probe')
      .set('Origin', 'http://localhost:4003');
    expect(local.headers['access-control-allow-origin']).toBeUndefined();
  });
});
