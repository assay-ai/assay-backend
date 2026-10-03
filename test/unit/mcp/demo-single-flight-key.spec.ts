import { Request } from 'express';

import { demoRunSingleFlightKey } from '@modules/mcp/controllers/public-demo.controller';

const request = (body: unknown) => ({ body }) as Request;

/**
 * The regression guard for a bug that shipped.
 *
 * `@SingleFlight`'s default key is pathname + `x-user-id` + query string. The
 * demo's two columns POST to the same path with no query string, so under the
 * default they coalesced into ONE call and the page rendered the healthy,
 * charged result in the column that exists to show a refusal. Caught only by
 * driving the real page in a browser — no unit test could have seen it, so
 * this one pins the property the fix depends on.
 */
describe('demoRunSingleFlightKey', () => {
  it('separates the two columns, which is the whole point', () => {
    const pass = demoRunSingleFlightKey(request({ side: 'pass', query: 'cargo ship' }));
    const fail = demoRunSingleFlightKey(request({ side: 'fail', query: 'cargo ship' }));

    expect(pass).not.toBe(fail);
  });

  it('separates two different questions on the same side', () => {
    const first = demoRunSingleFlightKey(request({ side: 'fail', query: 'cargo ship' }));
    const second = demoRunSingleFlightKey(request({ side: 'fail', query: 'oil tanker' }));

    expect(first).not.toBe(second);
  });

  it('coalesces the identical request, which is what single-flight is for', () => {
    const first = demoRunSingleFlightKey(request({ side: 'pass', query: 'cargo ship' }));
    const second = demoRunSingleFlightKey(request({ side: 'pass', query: 'cargo ship' }));

    expect(first).toBe(second);
  });

  it('does not throw on a missing body', () => {
    expect(() => demoRunSingleFlightKey(request(undefined))).not.toThrow();
  });
});
