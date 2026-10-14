import express from 'express';

import { parseTrustProxyHops } from '@config/app.config';

describe('API_TRUST_PROXY_HOPS', () => {
  it('defaults to 0, which ignores X-Forwarded-For', () => {
    expect(parseTrustProxyHops(undefined)).toBe(0);
    expect(parseTrustProxyHops('')).toBe(0);
  });

  it('takes a whole number of hops', () => {
    expect(parseTrustProxyHops('1')).toBe(1);
    expect(parseTrustProxyHops('2')).toBe(2);
  });

  it.each(['-1', '1.5', 'true', 'loopback'])('refuses %s', (raw) => {
    expect(() => parseTrustProxyHops(raw)).toThrow(/API_TRUST_PROXY_HOPS/);
  });

  it('with one hop, request.ip is the client the balancer saw, not the balancer', () => {
    const app = express();
    app.set('trust proxy', parseTrustProxyHops('1'));
    const request = Object.create(app.request, {
      app: { value: app },
      headers: { value: { 'x-forwarded-for': '203.0.113.7, 198.51.100.1' } },
      socket: { value: { remoteAddress: '10.0.0.2' } },
      connection: { value: { remoteAddress: '10.0.0.2' } },
    });
    expect(request.ip).toBe('198.51.100.1');

    app.set('trust proxy', parseTrustProxyHops(undefined));
    expect(request.ip).toBe('10.0.0.2');
  });
});
