import { randomUUID } from 'node:crypto';

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  HttpException,
} from '@nestjs/common';
import { Observable, Subscription } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { Request, Response } from 'express';
import { BaseError } from '@shared/errors/base.error';
import { SESSION_REQUEST_KEY } from '@shared/auth/session-request.key';
import { RequestContext, RequestContextStore, requestIdFromHeader } from '@shared/observability';

/**
 * One request, one `RequestContext`, plus the same information this
 * interceptor logged before (`method`, `url`, `statusCode`, response time,
 * `ip`, `userAgent`), now as structured fields rather than one formatted
 * string.
 *
 * ## Where `requestId` and `organizationId` come from
 *
 * `requestId` reads `x-request-id`, so an id set upstream (a gateway, a
 * caller that wants its own trace id honoured) survives — and generates one
 * when absent, because an internally-originated request still needs a trace.
 * Because the caller controls it, `serverRequestId` is minted here as well and
 * never read from the request; the override log records that one (L-7).
 *
 * `organizationId` reads `request[SESSION_REQUEST_KEY]` — the property
 * `SessionAuthGuard` sets (`src/shared/auth/session-auth.guard.ts`) — never a
 * header or query param, for the same reason that guard's docstring gives:
 * accepting it as input would let a caller attribute a log line to any
 * organization it names. Guards run before interceptors in Nest's request
 * lifecycle, so by the time `intercept()` runs, a route that used
 * `SessionAuthGuard` has already resolved its session. A route with no auth
 * guard, or one that failed, simply logs `organizationId: null`.
 *
 * ## Why `next.handle()` is CALLED inside `RequestContext.run`, not merely subscribed
 *
 * Both halves of this matter, and the second was found by measurement rather
 * than by reading — an earlier version of this file subscribed inside `run()`
 * but built the pipeline outside it, and every log line downstream of the
 * controller came out with `requestId: null` while the interceptor's own line
 * had it. The trace stopped exactly where it was supposed to start.
 *
 * `next.handle()` is not purely lazy. Nest's `InterceptorsConsumer` builds the
 * next link as an `async` function and calls it the moment `handle()` is
 * invoked, wrapping the resulting promise with `from(...)`. The controller
 * itself does run late, but it is subscribed from a microtask belonging to
 * *that promise chain* — and `AsyncLocalStorage` propagates from where a chain
 * was started, not from where it is awaited. Start the chain outside `run()`
 * and the controller inherits nothing, no matter where `subscribe()` happens.
 *
 * So the whole expression is built and subscribed inside the callback. The
 * `new Observable` wrapper is what makes that possible: Nest subscribes to
 * what `intercept()` returns after `intercept()` has already returned, so
 * there has to be somewhere to defer the work to.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const { method, url, ip } = request;
    const userAgent = request.get('user-agent') || '';
    const now = Date.now();
    const store = buildRequestContextStore(request);

    const pipeline = (): Observable<unknown> =>
      next.handle().pipe(
        tap(() => {
          const statusCode = response.statusCode;
          const responseTimeMs = Date.now() - now;
          this.logger.log({ method, url, statusCode, responseTimeMs, ip, userAgent }, 'HTTP');
        }),
        catchError((error) => {
          const responseTimeMs = Date.now() - now;
          const statusCode = statusCodeOf(error);
          const errorMessage =
            error instanceof Error ? error.message : String(error ?? 'Unknown error');

          this.logger.error(
            { method, url, statusCode, responseTimeMs, ip, userAgent, errorMessage },
            'HTTP',
          );
          throw error;
        }),
      );

    return new Observable((subscriber) => {
      let subscription: Subscription | undefined;
      RequestContext.run(store, () => {
        subscription = pipeline().subscribe(subscriber);
      });
      return () => subscription?.unsubscribe();
    });
  }
}

function buildRequestContextStore(request: Request): RequestContextStore {
  const requestId = requestIdFromHeader(request.headers['x-request-id']);
  const session = (request as unknown as Record<string, unknown>)[SESSION_REQUEST_KEY] as
    | { organizationId?: unknown }
    | undefined;
  const organizationId =
    typeof session?.organizationId === 'string' && session.organizationId.length > 0
      ? session.organizationId
      : null;

  return { requestId, organizationId, serverRequestId: randomUUID() };
}

function statusCodeOf(error: unknown): number {
  if (error instanceof HttpException) {
    return error.getStatus();
  }
  if (error instanceof BaseError) {
    return error.statusCode;
  }
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { statusCode?: unknown; status?: unknown };
    if (typeof candidate.statusCode === 'number') return candidate.statusCode;
    if (typeof candidate.status === 'number') return candidate.status;
  }
  return 500;
}
