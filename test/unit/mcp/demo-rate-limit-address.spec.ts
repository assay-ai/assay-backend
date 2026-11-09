import { Request } from 'express';

import { demoRateLimitAddress } from '@modules/mcp/controllers/public-demo.controller';

const request = (fields: { ip?: string; headers?: Record<string, string> }) =>
  ({ headers: {}, ...fields }) as unknown as Request;

/**
 * Review A-6: the public demo's per-address limit was keyed on the first
 * `X-Forwarded-For` entry, which the client writes. A new value on every
 * request was a new bucket, so one client could spend the demo's whole daily
 * budget in seconds and send the burst to the provider's upstream.
 *
 * The key is `request.ip`: Express derives it from the socket, and from the
 * forwarded chain only as far as the configured `trust proxy` hop count
 * allows, so a header the client wrote cannot move it.
 */
describe('demoRateLimitAddress', () => {
  it('keys on request.ip', () => {
    expect(demoRateLimitAddress(request({ ip: '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('ignores a client-supplied X-Forwarded-For', () => {
    const forged = (value: string) =>
      demoRateLimitAddress(request({ ip: '203.0.113.7', headers: { 'x-forwarded-for': value } }));

    expect(forged('198.51.100.1')).toBe('203.0.113.7');
    expect(forged('198.51.100.2, 10.0.0.1')).toBe('203.0.113.7');
  });

  // W-L1: every address of one IPv6 /64 shares one window, like the other limiters.
  it('groups IPv6 addresses by their /64', () => {
    const a = demoRateLimitAddress(request({ ip: '2001:db8:1:2::1' }));
    const b = demoRateLimitAddress(request({ ip: '2001:db8:1:2:abcd:ef01:2345:6789' }));
    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
    expect(demoRateLimitAddress(request({ ip: '2001:db8:1:3::1' }))).not.toBe(a);
    expect(demoRateLimitAddress(request({ ip: '::ffff:203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('answers one shared bucket, not a free one, when the address is unknown', () => {
    expect(demoRateLimitAddress(request({}))).toBe('unknown');
  });
});
