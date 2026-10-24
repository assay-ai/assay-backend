import { Body, Controller, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { json } from 'express';
import request from 'supertest';

import {
  ROUTE_BODY_LIMITS,
  applyApiCorsAndRouteBodyLimits,
  applyRouteBodyLimits,
} from '@bootstrap/api/route-body-limits';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';

/** The try route takes a 512 KB OpenAPI document; every other route keeps 100 KB. */
describe('route body limits', () => {
  function app() {
    const server = express();
    applyRouteBodyLimits(server);
    // Nest's own parser, mounted after: the default 100 KB.
    server.use(json());
    server.use((req, res) => {
      res.json({ bytes: JSON.stringify(req.body).length });
    });
    return server;
  }
  const body = (bytes: number) => ({ openapi: 'x'.repeat(bytes) });

  it('allows about 600 KB on the try route only', async () => {
    expect(ROUTE_BODY_LIMITS).toEqual([{ path: '/api/v1/provider/tools/try', limit: '600kb' }]);
    const big = body(512 * 1024);
    await request(app()).post('/api/v1/provider/tools/try').send(big).expect(200);
    await request(app())
      .post('/api/v1/provider/tools/try')
      .send(body(700 * 1024))
      .expect(413);
    await request(app()).post('/api/v1/provider/tools').send(big).expect(413);
    await request(app())
      .post('/api/v1/toolsets')
      .send(body(50 * 1024))
      .expect(200);
  });
});

@Controller()
class EchoController {
  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

/**
 * Nest skips its own JSON parser when any middleware named `jsonParser` is
 * already mounted, so a route-scoped parser must not carry that name.
 */
describe('route body limits in a Nest app', () => {
  it('keeps Nest parsing JSON on every other route', async () => {
    const app = await NestFactory.create<NestExpressApplication>(EchoModule, { logger: false });
    applyRouteBodyLimits(app);
    await app.init();
    try {
      const server = app.getHttpServer();
      await request(server).post('/echo').send({ name: 'x' }).expect(201, { name: 'x' });
      // The global limit stays at 100 KB; only the try route gets more.
      await request(server)
        .post('/echo')
        .send({ blob: 'x'.repeat(200 * 1024) })
        .expect(413);
      await request(server)
        .post('/api/v1/provider/tools/try')
        .send({ blob: 'x'.repeat(512 * 1024) })
        .expect(404);
    } finally {
      await app.close();
    }
  });
});

/**
 * The API's own CORS + route-parser setup (`applyApiCorsAndRouteBodyLimits`,
 * as `api/main.ts` calls it): a body the route-scoped parser refuses still
 * carries the CORS headers for a listed origin, so the page can read the 413.
 */
describe('route body limits after the API CORS policy', () => {
  const ORIGIN = 'http://localhost:4001';

  async function appWithApiCors() {
    const app = await NestFactory.create<NestExpressApplication>(EchoModule, { logger: false });
    applyApiCorsAndRouteBodyLimits(app, [ORIGIN]);
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    return app;
  }

  it('answers an oversized try body 413 PAYLOAD_TOO_LARGE with the CORS header', async () => {
    const app = await appWithApiCors();
    try {
      const response = await request(app.getHttpServer())
        .post('/api/v1/provider/tools/try')
        .set('Origin', ORIGIN)
        .send({ openapi: 'x'.repeat(700 * 1024) });
      expect(response.status).toBe(413);
      expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(response.body).toMatchObject({
        success: false,
        error: { code: 'PAYLOAD_TOO_LARGE', statusCode: 413 },
      });
    } finally {
      await app.close();
    }
  });

  it('gives an unlisted origin no Access-Control-Allow-Origin on the same 413', async () => {
    const app = await appWithApiCors();
    try {
      const response = await request(app.getHttpServer())
        .post('/api/v1/provider/tools/try')
        .set('Origin', 'https://evil.example')
        .send({ openapi: 'x'.repeat(700 * 1024) });
      expect(response.status).toBe(413);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
