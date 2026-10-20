import { Body, Controller, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { json } from 'express';
import request from 'supertest';

import { ROUTE_BODY_LIMITS, applyRouteBodyLimits } from '@bootstrap/api/route-body-limits';

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
