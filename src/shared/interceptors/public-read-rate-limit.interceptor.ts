import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';

/** Requests one address may make per window, across the routes that use this. */
export const PUBLIC_READ_LIMIT = 120;
export const PUBLIC_READ_WINDOW_MS = 60_000;
/** Addresses tracked at once. Past this, expired windows are swept, then all. */
export const PUBLIC_READ_MAX_ADDRESSES = 10_000;

/**
 * A per-address fixed window for the unauthenticated **read** routes.
 *
 * ## Why in-process, and why not the demo's Redis limiter
 *
 * `RedisDemoRateLimiter` protects money and a third party's endpoint, so it
 * fails closed and must agree across instances. These routes spend nothing and
 * every answer is already served from an in-process cache, so the limit only
 * has to stop one address hammering one instance — a bounded `Map` does that
 * with no new connection and no failure mode of its own. With N API instances
 * the effective ceiling is N × {@link PUBLIC_READ_LIMIT}, which is still a
 * bound.
 *
 * ## Why an interceptor and not a guard
 *
 * A public controller declares no guard at all (`surface-consistency.spec.ts`
 * pins that, so a route meant to be open cannot pick up an auth guard on the
 * way past). This decides nothing about *who* the caller is, only how often.
 *
 * `request.ip` is the address, never a header read here: Express derives it
 * from the socket and `trust proxy`, which the bootstrap sets — the same
 * reasoning as the demo controller's `clientAddress`.
 */
@Injectable()
export class PublicReadRateLimitInterceptor implements NestInterceptor {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  /** The clock; a field rather than a constructor parameter so DI has nothing to resolve. */
  now: () => number = Date.now;

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    if (!this.take(request.ip ?? 'unknown')) {
      throw new HttpException(
        'Too many requests from this address. Try again shortly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return next.handle();
  }

  /** Count one request from `address`; false when it is over the limit. */
  take(address: string): boolean {
    const now = this.now();
    let window = this.windows.get(address);

    if (!window || now - window.startedAt >= PUBLIC_READ_WINDOW_MS) {
      if (!window && this.windows.size >= PUBLIC_READ_MAX_ADDRESSES) this.sweep(now);
      window = { startedAt: now, count: 0 };
      this.windows.set(address, window);
    }

    window.count += 1;
    return window.count <= PUBLIC_READ_LIMIT;
  }

  private sweep(now: number): void {
    for (const [address, window] of this.windows) {
      if (now - window.startedAt >= PUBLIC_READ_WINDOW_MS) this.windows.delete(address);
    }
    // Still full of live windows: a flood of distinct addresses. Forgetting
    // them all is the bounded choice — memory matters more than a precise
    // count for a read that is cached anyway.
    if (this.windows.size >= PUBLIC_READ_MAX_ADDRESSES) this.windows.clear();
  }
}
