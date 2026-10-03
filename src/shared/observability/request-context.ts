import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * The correlation the whole observability design is built on: one trace per
 * tool call, spanning the async boundary — verification runs
 * *after* the agent is unblocked, so a trace that ends at the HTTP response
 * misses the half of the system where money moves.
 *
 * `organizationId` is deliberately optional here even though
 * `OrganizationScopedRepository` makes it mandatory everywhere else in this
 * codebase (`ORGANIZATION_SCOPE_MISSING`) — a request context exists for
 * public and pre-auth routes too (health checks, `tools/list` before a bearer
 * token resolves a session), and this module has no opinion on whether a
 * given call site requires one. It only carries what a guard or a queue
 * publisher was able to resolve.
 */
export interface RequestContextStore {
  readonly requestId: string;
  readonly organizationId: string | null;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/**
 * The one instance every process shares — an HTTP interceptor enters it per
 * request, a `StructuredLogger` reads it on every log call.
 *
 * `AsyncLocalStorage`, not a request-scoped Nest provider: the log call sites
 * this exists for — `QueueProcessorBase`'s `this.logger`, a service buried
 * three calls deep in `judgeAndSettle` — are never going to accept an
 * injected context object without a much larger refactor, and ALS is the
 * house precedent for exactly this shape of problem (see
 * `src/shared/network/egress/egress-lockdown.ts`'s `sanctioned` store, which
 * this mirrors).
 */
export const RequestContext = {
  /** Run `fn` with `store` as the ambient context for its entire async extent. */
  run<T>(store: RequestContextStore, fn: () => T): T {
    return storage.run(store, fn);
  },

  /** The active store, or `undefined` outside any `run()` — e.g. at boot. */
  get(): RequestContextStore | undefined {
    return storage.getStore();
  },

  /** `null`, never a made-up id, when called outside `run()`. */
  getRequestId(): string | null {
    return storage.getStore()?.requestId ?? null;
  },

  getOrganizationId(): string | null {
    return storage.getStore()?.organizationId ?? null;
  },
};

/** Same truncation `operator-cases.controller.ts`'s `requestIdOf` applies. */
const MAX_REQUEST_ID_LENGTH = 64;

/**
 * Reads `x-request-id`, generating one when the caller did not send it.
 *
 * Mirrors `requestIdOf` in `operator-cases.controller.ts` for the "read the
 * header" half; the difference is this always returns a usable id rather than
 * `null`; a request that arrived with no header still deserves a trace, and a
 * generated id is what makes an internally-initiated call (a cron tick, a
 * queue wakeup with no HTTP origin) traceable at all.
 */
export function requestIdFromHeader(header: string | readonly string[] | undefined): string {
  if (typeof header === 'string' && header.length > 0) {
    return header.slice(0, MAX_REQUEST_ID_LENGTH);
  }
  if (Array.isArray(header) && header.length > 0 && header[0].length > 0) {
    return header[0].slice(0, MAX_REQUEST_ID_LENGTH);
  }
  return randomUUID();
}
