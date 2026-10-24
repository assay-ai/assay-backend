import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server } from 'socket.io';

import { parseCorsAllowedOrigins } from '@config/app.config';
import { socketIoServerOptions } from '@websocket/adapters/redis-io.adapter';

/**
 * The socket.io server answers `/socket.io/` itself, so the HTTP layer's
 * `enableCors` never reaches it (BUG-SEC-03). These run a real engine.io
 * server with the options the adapter builds and check the headers a browser
 * would get: the listed origin reflected with credentials, any other none.
 */
describe('socket.io CORS (BUG-SEC-03)', () => {
  const LISTED = 'http://localhost:4000';
  let http: HttpServer;
  let io: Server;
  let base: string;

  beforeAll(async () => {
    http = createServer();
    io = new Server(
      http,
      socketIoServerOptions({ cors: { origin: '*' } }, parseCorsAllowedOrigins(LISTED, 'test')),
    );
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });

  const poll = (origin: string, method = 'GET') =>
    fetch(`${base}/socket.io/?EIO=4&transport=polling`, {
      method,
      headers: {
        Origin: origin,
        ...(method === 'OPTIONS' ? { 'Access-Control-Request-Method': 'GET' } : {}),
      },
    });

  it('reflects an allow-listed origin with credentials', async () => {
    const res = await poll(LISTED);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(LISTED);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('answers a preflight from the listed origin', async () => {
    const res = await poll(LISTED, 'OPTIONS');
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('access-control-allow-origin')).toBe(LISTED);
  });

  it('sends no CORS header to an origin that is not listed, even when a gateway asked for *', async () => {
    for (const method of ['GET', 'OPTIONS']) {
      const res = await poll('http://evil.example', method);
      // Without Allow-Origin the browser reads nothing (the `cors` package
      // still sends Allow-Credentials, as on the API; it grants nothing alone).
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('uses exactly the given list and keeps the other options', () => {
    const options = socketIoServerOptions({ path: '/socket.io', cors: { origin: '*' } }, [LISTED]);
    expect(options).toMatchObject({
      path: '/socket.io',
      cors: { origin: [LISTED], credentials: true },
    });
  });
});
