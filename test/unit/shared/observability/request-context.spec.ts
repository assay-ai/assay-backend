import { RequestContext, requestIdFromHeader } from '@shared/observability';

/**
 * The primitive every other correlation piece is built on: a
 * `requestId` (and, once a session resolves one, an `organizationId`) that
 * survives an `await`, not just the synchronous call that started it. If this
 * did not hold, a log line written from inside a promise chain kicked off
 * under `RequestContext.run()` would silently lose the trace — exactly the
 * failure request tracing exists to prevent: a trace that ends at the response
 * misses the half of the system where money moves.
 */
describe('RequestContext', () => {
  it('reads null for both fields outside any run()', () => {
    expect(RequestContext.get()).toBeUndefined();
    expect(RequestContext.getRequestId()).toBeNull();
    expect(RequestContext.getOrganizationId()).toBeNull();
  });

  it('exposes the store for the synchronous extent of run()', () => {
    RequestContext.run({ requestId: 'req-1', organizationId: 'org-1' }, () => {
      expect(RequestContext.getRequestId()).toBe('req-1');
      expect(RequestContext.getOrganizationId()).toBe('org-1');
    });

    // Does not leak past the call.
    expect(RequestContext.getRequestId()).toBeNull();
  });

  it('carries organizationId as null when a session never resolved one', () => {
    RequestContext.run({ requestId: 'req-2', organizationId: null }, () => {
      expect(RequestContext.getOrganizationId()).toBeNull();
    });
  });

  it('survives an await inside the run() callback — the async boundary this exists for', async () => {
    const seenAcrossAwait = await RequestContext.run(
      { requestId: 'req-3', organizationId: 'org-3' },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return {
          requestId: RequestContext.getRequestId(),
          organizationId: RequestContext.getOrganizationId(),
        };
      },
    );

    expect(seenAcrossAwait).toEqual({ requestId: 'req-3', organizationId: 'org-3' });
  });

  it('keeps two concurrent run() calls from bleeding into each other', async () => {
    const results = await Promise.all([
      RequestContext.run({ requestId: 'a', organizationId: null }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return RequestContext.getRequestId();
      }),
      RequestContext.run({ requestId: 'b', organizationId: null }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return RequestContext.getRequestId();
      }),
    ]);

    expect(results).toEqual(['a', 'b']);
  });

  it('does not leak into work merely scheduled concurrently, not run() inside it', async () => {
    // A plain, un-scoped async function running "at the same time" as a
    // RequestContext.run() call must not see that call's store — the same
    // property `egress-lockdown.ts`'s `sanctioned` AsyncLocalStorage relies
    // on (see that file's docstring on why ALS, not a boolean flag, was
    // required).
    const outsideDuringRun: (string | null)[] = [];

    const runPromise = RequestContext.run(
      { requestId: 'inside', organizationId: null },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    );

    outsideDuringRun.push(RequestContext.getRequestId());
    await runPromise;

    expect(outsideDuringRun).toEqual([null]);
  });

  it('nested run() shadows the outer store for its own extent, then restores it', () => {
    RequestContext.run({ requestId: 'outer', organizationId: 'org-outer' }, () => {
      RequestContext.run({ requestId: 'inner', organizationId: 'org-inner' }, () => {
        expect(RequestContext.getRequestId()).toBe('inner');
      });
      expect(RequestContext.getRequestId()).toBe('outer');
    });
  });
});

describe('requestIdFromHeader', () => {
  it('uses a plain string header verbatim', () => {
    expect(requestIdFromHeader('client-supplied-id')).toBe('client-supplied-id');
  });

  it('uses the first value of a multi-value header', () => {
    expect(requestIdFromHeader(['first-id', 'second-id'])).toBe('first-id');
  });

  it('truncates to 64 characters — the same cap operator-cases.controller.ts applies', () => {
    const long = 'x'.repeat(100);
    const result = requestIdFromHeader(long);
    expect(result).toHaveLength(64);
    expect(result).toBe('x'.repeat(64));
  });

  it('generates a UUID when the header is absent', () => {
    const generated = requestIdFromHeader(undefined);
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('generates a UUID when the header is an empty string', () => {
    const generated = requestIdFromHeader('');
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('generates a UUID when the header is an empty array', () => {
    const generated = requestIdFromHeader([]);
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('generates a different id on each call with no header', () => {
    expect(requestIdFromHeader(undefined)).not.toBe(requestIdFromHeader(undefined));
  });
});
