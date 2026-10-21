import { Controller, INestApplication, Post, Req, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import request from 'supertest';

import { McpExceptionsFilter } from '@bootstrap/mcp/mcp-exceptions.filter';

@Controller('oauth')
class EchoController {
  @Post(['token', 'revoke', 'register'])
  echo(@Req() req: Request, @Res() res: Response): void {
    res.status(200).json({ ok: true, body: req.body });
  }
}

@Controller()
class OtherController {
  @Post('elsewhere')
  echo(@Req() req: Request): unknown {
    return req.body;
  }
}

/**
 * The MCP app's global filter (spec §6.3.8, §6.3.10, §6.3.12): a body the
 * parser refuses on an OAuth body route answers in RFC 6749 shape; everything
 * else keeps the platform's shape.
 */
describe('McpExceptionsFilter', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EchoController, OtherController],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new McpExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  it.each(['/oauth/token', '/oauth/revoke', '/oauth/register', '/OAuth/Token/'])(
    'malformed JSON on %s → 400 {"error":"invalid_request"}, no-store',
    async (path) => {
      const response = await request(app.getHttpServer())
        .post(path)
        .set('Content-Type', 'application/json')
        .send('{bad');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_request' });
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it('an oversized form body on /oauth/token → 400 invalid_request', async () => {
    const response = await request(app.getHttpServer())
      .post('/oauth/token')
      .type('form')
      .send(`code=${'a'.repeat(200_000)}`);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
  });

  it('a well-formed body still reaches the handler', async () => {
    const response = await request(app.getHttpServer())
      .post('/oauth/token')
      .type('form')
      .send('grant_type=x');
    expect(response.status).toBe(200);
  });

  it('elsewhere the platform shape is kept', async () => {
    const response = await request(app.getHttpServer())
      .post('/elsewhere')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, error: { statusCode: 400 } });
  });

  it('an oversized JSON body elsewhere → 413 PAYLOAD_TOO_LARGE, not 500 (BUG-NF-01)', async () => {
    const response = await request(app.getHttpServer())
      .post('/elsewhere')
      .send({ a: 'x'.repeat(200_000) });
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        statusCode: 413,
        message: 'The request body is too large.',
      },
    });
  });

  it('a body under the limit elsewhere is still accepted', async () => {
    const response = await request(app.getHttpServer())
      .post('/elsewhere')
      .send({ a: 'x'.repeat(50_000) });
    expect(response.status).toBe(201);
  });
});
