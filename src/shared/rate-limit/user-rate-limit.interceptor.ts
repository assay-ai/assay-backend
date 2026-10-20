import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { Observable, defer, finalize, from, mergeMap } from 'rxjs';

import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import type { OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OPERATOR_REQUEST_KEY } from '@shared/auth/operator-request.key';
import { SESSION_REQUEST_KEY } from '@shared/auth/session-request.key';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { clientKey } from '@shared/interceptors/address-rate-limit.interceptor';

import { RateOutcome, SharedRateWindows } from './shared-rate-windows';
import {
  CONCURRENT_SLOT_TTL_MS,
  EXEMPT_PATH_PREFIXES,
  OWN_LIMITER_ROUTES,
  READ_RULE,
  ROUTE_RULES,
  RateRule,
  RateSubject,
  USER_RATE_MAX_KEYS,
  WRITE_RULE,
} from './user-rate-limit.config';

/** DI token: whether {@link UserRateLimitInterceptor} counts anything (`API_USER_RATE_LIMITS_ENABLED`). */
export const USER_RATE_LIMITS_ENABLED = Symbol('USER_RATE_LIMITS_ENABLED');

/** What one request counts against: the rule, and whose window. */
export interface RateDecision {
  readonly route: string;
  readonly rule: RateRule;
  readonly subject: string;
}

const OWN_LIMITER = new Set(OWN_LIMITER_ROUTES);

/**
 * The per-caller windows of `user-rate-limit.config.ts`, applied to every
 * route of the dashboard API from one place.
 *
 * ## Why a global interceptor
 *
 * Interceptors run after guards, so by the time this runs `SessionAuthGuard`
 * or `OperatorAuthGuard` has attached the caller (`request.session`,
 * `request.operator`), and a request they refused never gets here: an
 * unauthenticated flood is not counted against anybody's window. It is
 * registered once (`UserRateLimitModule`, `APP_INTERCEPTOR`) and reads its
 * categories from the config file, so no controller carries a decorator for it.
 *
 * The route is the one Express matched (`request.route.path`, e.g.
 * `/api/v1/deposits/:depositId`), with the global prefix and version taken
 * off, so a rule is written the way the controller declares the route.
 *
 * ## Answer when over
 *
 * `429` with `Retry-After` (exposed to browser clients by
 * `API_EXPOSED_HEADERS`) and the usual error envelope, code
 * `TOO_MANY_REQUESTS`, which the console shows with the wait in it.
 */
@Injectable()
export class UserRateLimitInterceptor implements NestInterceptor {
  private readonly windows: SharedRateWindows;

  /** The clock; a field rather than a constructor parameter so DI has nothing to resolve. */
  now: () => number = Date.now;

  constructor(
    @Optional() @Inject(REDIS_CACHE_CLIENT) redis?: Redis,
    @Optional() @Inject(USER_RATE_LIMITS_ENABLED) private readonly enabled: boolean = true,
  ) {
    this.windows = new SharedRateWindows({
      redis,
      keyPrefix: 'rate:user:',
      maxKeys: USER_RATE_MAX_KEYS,
      now: () => this.now(),
      logger: new Logger(UserRateLimitInterceptor.name),
      warnEveryMs: 60_000,
    });
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.enabled === false || context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const decision = decide(http.getRequest<Request>());
    if (!decision) return next.handle();

    const response = http.getResponse<Response>();
    return from(this.admit(decision)).pipe(
      mergeMap((outcome) => {
        if (!outcome.allowed) refuse(response, outcome.retryAfterSeconds);
        if (!outcome.release) return next.handle();
        // Deferred, so a handler that throws still gives its slot back.
        return defer(() => next.handle()).pipe(finalize(outcome.release));
      }),
    );
  }

  /** Count the request; take a concurrency slot when the rule has one. */
  async admit(decision: RateDecision): Promise<RateOutcome & { release?: () => void }> {
    const { rule, subject } = decision;
    const outcome = await this.windows.take(`${rule.bucket}:${subject}`, rule);
    if (!outcome.allowed || rule.concurrent === undefined) return outcome;

    const release = await this.windows.acquireSlot(
      `${rule.bucket}:inflight:${subject}`,
      rule.concurrent,
      CONCURRENT_SLOT_TTL_MS,
    );
    // One already running: try again in a few seconds, not at the window's end.
    if (!release) return { allowed: false, retryAfterSeconds: 5 };
    return { ...outcome, release };
  }
}

/**
 * Which window a request counts against, or `null` for none: an exempt
 * route, or a caller no guard identified on a route keyed by caller.
 */
export function decide(request: Request): RateDecision | null {
  const method = request.method.toUpperCase() === 'HEAD' ? 'GET' : request.method.toUpperCase();
  if (method === 'OPTIONS') return null;

  const path = routePath(request);
  if (EXEMPT_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) {
    return null;
  }

  const route = `${method} ${path}`;
  if (OWN_LIMITER.has(route)) return null;

  const rule = ROUTE_RULES[route] ?? (method === 'GET' ? READ_RULE : WRITE_RULE);
  const subject = subjectOf(request, rule.subject);
  return subject ? { route, rule, subject } : null;
}

/** The matched route as its controller declares it: `/api/v1/deposits/:depositId` → `/deposits/:depositId`. */
export function routePath(request: Request): string {
  const matched = (request.route as { path?: unknown } | undefined)?.path;
  const raw = typeof matched === 'string' ? matched : (request.path ?? request.url ?? '/');
  const path = raw.split('?')[0].replace(/^\/api(?:\/v\d+)?(?=\/|$)/, '') || '/';
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function subjectOf(request: Request, subject: RateSubject): string | null {
  if (subject === RateSubject.ADDRESS) return `ip:${clientKey(request.ip)}`;

  const record = request as unknown as Record<string, unknown>;
  const operator = record[OPERATOR_REQUEST_KEY] as OperatorSession | undefined;
  if (operator?.operatorId) return `op:${operator.operatorId}`;

  const session = record[SESSION_REQUEST_KEY] as McpSession | undefined;
  if (!session?.organizationId) return null;

  switch (subject) {
    case RateSubject.ORGANIZATION:
      return `org:${session.organizationId}`;
    case RateSubject.ACCOUNT:
      return `acct:${session.agentAccount}`;
    case RateSubject.CREDENTIAL:
      return `cred:${session.credentialId}`;
    default:
      // A person is their agent in their organization; a key or an OAuth
      // grant is its credential.
      return session.callerKind === McpCallerKind.HUMAN
        ? `person:${session.organizationId}:${session.agentId}`
        : `cred:${session.credentialId}`;
  }
}

function refuse(response: Response, retryAfterSeconds: number): never {
  response.setHeader('Retry-After', String(retryAfterSeconds));
  throw new HttpException(
    `Too many requests. Try again in ${retryAfterSeconds} s.`,
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
