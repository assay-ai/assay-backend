import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';

/** Requests one client may make per window, across the routes that use this. */
export const PUBLIC_READ_LIMIT = 120;
export const PUBLIC_READ_WINDOW_MS = 60_000;
/** Clients tracked at once. Past this, expired windows go first, then the oldest. */
export const PUBLIC_READ_MAX_ADDRESSES = 10_000;

/**
 * A per-client fixed window for the unauthenticated **read** routes.
 *
 * ## Why in-process, and why not the demo's Redis limiter
 *
 * `RedisDemoRateLimiter` protects money and a third party's endpoint, so it
 * fails closed and must agree across instances. These routes spend nothing and
 * every answer is already served from an in-process cache, so the limit only
 * has to stop one client hammering one instance — a bounded `Map` does that
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
 * ## Who the client is
 *
 * `request.ip`, never a header read here: Express derives it from the socket
 * and `trust proxy`. **`API_TRUST_PROXY_HOPS` must equal the real number of
 * proxies in front of the API** (Cloudflare plus a load balancer is 2). Too
 * low and every visitor shares the proxy's address and one limit; too high and
 * a visitor picks their own address with `X-Forwarded-For`. The Explorer is a
 * static export calling these routes from the visitor's browser, so there is
 * no shared frontend-server address to account for.
 *
 * An IPv6 client is keyed by its 64-bit prefix (its "/64"): one subscriber
 * usually holds a whole prefix, and keying by the full address would hand them 2^64 separate limits.
 */
@Injectable()
export class PublicReadRateLimitInterceptor implements NestInterceptor {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  /** The clock; a field rather than a constructor parameter so DI has nothing to resolve. */
  now: () => number = Date.now;

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const outcome = this.take(clientKey(request.ip));

    if (!outcome.allowed) {
      http.getResponse<Response>().setHeader('Retry-After', String(outcome.retryAfterSeconds));
      throw new HttpException(
        'Too many requests from this address. Try again shortly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return next.handle();
  }

  /** Count one request from `client`; refused with the seconds until its window resets. */
  take(client: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    let window = this.windows.get(client);

    if (!window || now - window.startedAt >= PUBLIC_READ_WINDOW_MS) {
      // Re-inserted, so the map's insertion order stays oldest-window-first.
      this.windows.delete(client);
      if (this.windows.size >= PUBLIC_READ_MAX_ADDRESSES) this.evict(now);
      window = { startedAt: now, count: 0 };
      this.windows.set(client, window);
    }

    window.count += 1;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((window.startedAt + PUBLIC_READ_WINDOW_MS - now) / 1000),
    );
    return { allowed: window.count <= PUBLIC_READ_LIMIT, retryAfterSeconds };
  }

  /** Drop expired windows; if still full, drop the oldest until there is room. */
  private evict(now: number): void {
    for (const [client, window] of this.windows) {
      if (now - window.startedAt >= PUBLIC_READ_WINDOW_MS) this.windows.delete(client);
    }
    for (const client of this.windows.keys()) {
      if (this.windows.size < PUBLIC_READ_MAX_ADDRESSES) break;
      this.windows.delete(client);
    }
  }
}

/**
 * The rate-limit key for an address: IPv4 as is (also when IPv4-mapped in
 * IPv6), IPv6 reduced to its /64 prefix.
 */
export function clientKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;

  const address = ip.split('%')[0].toLowerCase();
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right];

  return `${groups
    .slice(0, 4)
    .map((group) => (parseInt(group, 16) || 0).toString(16))
    .join(':')}::/64`;
}
