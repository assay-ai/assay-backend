import { describe, expect, it } from 'vitest';
import { handleRelay, RELAY_ALLOWED_PORTS, type RelayEnv } from '../src/relay';

const env: RelayEnv = { RELAY_TOKEN: 'tok-current', RELAY_TOKEN_NEXT: 'tok-next' };

function envelope(over: Record<string, unknown> = {}) {
  return {
    url: 'https://p.test/v1?q=1',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-keep': 'yes' },
    body: '{"a":1}',
    timeoutMs: 1000,
    maxResponseBytes: 1024,
    ...over,
  };
}

function req(body: unknown, token: string | null = 'tok-current') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request('https://relay.test/v1/relay', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function recorder(
  res: () => Response | Promise<Response> = () => new Response('ok', { status: 200 }),
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: any, init: RequestInit) => {
    calls.push({ url: String(input), init });
    return res();
  }) as unknown as typeof fetch;
  return { calls, impl };
}

async function expectError(res: Response, kind: string) {
  expect(res.status).toBe(502);
  expect(res.headers.get('x-assay-relay')).toBe('error');
  expect(await res.json()).toEqual({ kind });
}

describe('handleRelay', () => {
  it('rejects missing or wrong bearer without calling fetch', async () => {
    const f = recorder();
    await expectError(await handleRelay(req(envelope(), null), env, f.impl), 'UNAUTHORIZED');
    await expectError(await handleRelay(req(envelope(), 'nope'), env, f.impl), 'UNAUTHORIZED');
    expect(f.calls).toHaveLength(0);
  });

  it('accepts RELAY_TOKEN_NEXT', async () => {
    const f = recorder();
    const res = await handleRelay(req(envelope(), 'tok-next'), env, f.impl);
    expect(res.headers.get('x-assay-relay')).toBe('upstream');
    expect(f.calls).toHaveLength(1);
  });

  it('rejects non-JSON and malformed envelopes', async () => {
    const f = recorder();
    await expectError(await handleRelay(req('not json'), env, f.impl), 'BAD_REQUEST');
    await expectError(await handleRelay(req(envelope({ url: 42 })), env, f.impl), 'BAD_REQUEST');
    await expectError(
      await handleRelay(req(envelope({ url: 'nonsense' })), env, f.impl),
      'BAD_REQUEST',
    );
    expect(f.calls).toHaveLength(0);
  });

  it('rejects CONNECT and other disallowed methods', async () => {
    const f = recorder();
    await expectError(
      await handleRelay(req(envelope({ method: 'CONNECT' })), env, f.impl),
      'BAD_REQUEST',
    );
    await expectError(
      await handleRelay(req(envelope({ method: 'TRACE' })), env, f.impl),
      'BAD_REQUEST',
    );
    expect(f.calls).toHaveLength(0);
  });

  it('rejects more than 64 headers', async () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 65; i++) headers[`x-h${i}`] = 'v';
    await expectError(
      await handleRelay(req(envelope({ headers })), env, recorder().impl),
      'BAD_REQUEST',
    );
  });

  it('blocks http unless ALLOW_HTTP=1', async () => {
    const f = recorder();
    await expectError(
      await handleRelay(req(envelope({ url: 'http://p.test' })), env, f.impl),
      'BLOCKED_TARGET',
    );
    const res = await handleRelay(
      req(envelope({ url: 'http://p.test' })),
      { ...env, ALLOW_HTTP: '1' },
      f.impl,
    );
    expect(res.headers.get('x-assay-relay')).toBe('upstream');
  });

  it.each([
    'https://10.0.0.1/',
    'https://[::1]/',
    'https://[::ffff:7f00:1]/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://0177.0.0.1/',
    'https://127.1/',
    'https://0x7f.1/',
  ])('blocks IP literal %s', async (url) => {
    const f = recorder();
    await expectError(await handleRelay(req(envelope({ url })), env, f.impl), 'BLOCKED_TARGET');
    expect(f.calls).toHaveLength(0);
  });

  it('blocks userinfo in the URL', async () => {
    await expectError(
      await handleRelay(req(envelope({ url: 'https://u:p@p.test/' })), env, recorder().impl),
      'BLOCKED_TARGET',
    );
  });

  it('enforces the port allow-list', async () => {
    const f = recorder();
    await expectError(
      await handleRelay(req(envelope({ url: 'https://p.test:3000/' })), env, f.impl),
      'BLOCKED_TARGET',
    );
    expect(RELAY_ALLOWED_PORTS).toEqual([443, 8443, 2053, 2083, 2087, 2096]);
    const res = await handleRelay(req(envelope({ url: 'https://p.test:8443/' })), env, f.impl);
    expect(res.headers.get('x-assay-relay')).toBe('upstream');
  });

  it('relays with redirect manual, stripped headers, and passes 3xx through', async () => {
    const f = recorder(
      () =>
        new Response('moved', {
          status: 302,
          headers: { location: 'https://x.test/', connection: 'close' },
        }),
    );
    const res = await handleRelay(
      req(
        envelope({
          headers: {
            host: 'evil',
            'X-Forwarded-For': '1.2.3.4',
            'cf-connecting-ip': '1.2.3.4',
            'cf-ray': 'x',
            'x-real-ip': '1',
            forwarded: 'for=1',
            connection: 'close',
            'proxy-authorization': 'x',
            'x-keep': 'yes',
          },
        }),
      ),
      env,
      f.impl,
    );
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe('https://p.test/v1?q=1');
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    const sent = new Headers(init.headers as HeadersInit);
    expect([...sent.keys()].sort()).toEqual(['x-keep']);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://x.test/');
    expect(res.headers.get('connection')).toBeNull();
    expect(res.headers.get('x-assay-relay')).toBe('upstream');
    expect(await res.text()).toBe('moved');
  });

  it('sends no body for GET', async () => {
    const f = recorder();
    await handleRelay(req(envelope({ method: 'GET', body: null })), env, f.impl);
    expect(f.calls[0].init.body ?? null).toBeNull();
  });

  it('returns TIMEOUT when fetch hangs past timeoutMs', async () => {
    const impl = ((_u: any, init: RequestInit) =>
      new Promise((_r, rej) => {
        init.signal!.addEventListener('abort', () => rej(init.signal!.reason));
      })) as unknown as typeof fetch;
    await expectError(await handleRelay(req(envelope({ timeoutMs: 30 })), env, impl), 'TIMEOUT');
  });

  it('returns TOO_LARGE when a stream without content-length exceeds the cap', async () => {
    const f = recorder(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(8));
              c.enqueue(new Uint8Array(8));
              c.close();
            },
          }),
        ),
    );
    await expectError(
      await handleRelay(req(envelope({ maxResponseBytes: 10 })), env, f.impl),
      'TOO_LARGE',
    );
  });

  it('blocks internal host names', async () => {
    for (const url of [
      'https://localhost/',
      'https://a.localhost/',
      'https://x.local/',
      'https://db.internal/',
    ]) {
      await expectError(
        await handleRelay(req(envelope({ url })), env, recorder().impl),
        'BLOCKED_TARGET',
      );
    }
  });

  it('ALLOW_HTTP relaxes only the scheme; port check stays', async () => {
    const e = { ...env, ALLOW_HTTP: '1' };
    await expectError(
      await handleRelay(req(envelope({ url: 'http://p.test:6379' })), e, recorder().impl),
      'BLOCKED_TARGET',
    );
    const res = await handleRelay(req(envelope({ url: 'http://p.test:80/' })), e, recorder().impl);
    expect(res.headers.get('x-assay-relay')).toBe('upstream');
  });

  it('returns CONNECT for an upstream status outside 200-599', async () => {
    const impl = (async () => ({
      status: 101,
      statusText: '',
      headers: new Headers(),
      body: null,
    })) as unknown as typeof fetch;
    await expectError(await handleRelay(req(envelope()), env, impl), 'CONNECT');
  });

  it('returns TOO_LARGE up front when content-length exceeds the cap', async () => {
    const f = recorder(
      () => new Response('x'.repeat(100), { headers: { 'content-length': '100' } }),
    );
    await expectError(
      await handleRelay(req(envelope({ maxResponseBytes: 10 })), env, f.impl),
      'TOO_LARGE',
    );
  });

  it('returns CONNECT when fetch throws TypeError', async () => {
    const impl = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    await expectError(await handleRelay(req(envelope()), env, impl), 'CONNECT');
  });
});
