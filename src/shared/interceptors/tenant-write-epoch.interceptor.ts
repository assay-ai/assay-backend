import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, throwError } from 'rxjs';
import { catchError, concatMap } from 'rxjs/operators';

import { BLOCKED_SESSION_READ_ONLY_METADATA } from '@shared/auth/blocked-session-read-only.decorator';
import { OPERATOR_REQUEST_KEY } from '@shared/auth/operator-request.key';
import { SESSION_REQUEST_KEY } from '@shared/auth/session-request.key';
import {
  ORGANIZATION_EPOCH_SCOPES,
  RequestBumps,
  TenantEpochService,
} from '@shared/cache/redis-cache/tenant-epoch.service';
import {
  BUMPS_OPERATOR_CONSOLE_KEY,
  NO_EPOCH_BUMP_KEY,
} from '@shared/decorators/tenant-write.decorator';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The caller's own write is visible on their next read, whatever it touched.
 *
 * After a signed-in `POST`/`PUT`/`PATCH`/`DELETE` returns — its handler has
 * committed by then — every per-organization epoch of the caller's
 * organization is bumped before the response leaves (one Redis round trip),
 * so no cached read of that organization (`@TenantCache`) can answer with
 * the pre-write body. Bumps that commit hooks fired during the request
 * (`TenantEpochService.bumpAfterCommit`) are awaited here too.
 *
 * - An operator's write bumps the global operator and shared scopes.
 * - An organization's write bumps the operator scope only where the console
 *   lists what it wrote (`@BumpsOperatorConsole`, on the class or handler).
 * - A `POST` that only reads bumps nothing: `@NoEpochBump` or
 *   `@BlockedSessionReadOnly`, on the handler or its class.
 * - A failed write bumps too, since a handler can commit part of its work
 *   before it throws — except a Nest `HttpException`, which on this surface
 *   only pipes (validation) and limiters throw, before any handler runs.
 *   Domain errors are `AppError`s and always bump.
 *
 * It does not cover a write that changes ANOTHER organization's data (a
 * dispute the provider must answer, an operator decision, a credit to a
 * provider) nor work done by MCP calls, workers and the scheduler: those bump
 * where they write, or rely on the cached route's short TTL.
 */
@Injectable()
export class TenantWriteEpochInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly epochs: TenantEpochService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    if (!WRITE_METHODS.has(String(request.method))) return next.handle();
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean>(NO_EPOCH_BUMP_KEY, targets) ||
      this.reflector.getAllAndOverride<boolean>(BLOCKED_SESSION_READ_ONLY_METADATA, targets)
    ) {
      return next.handle();
    }
    const operatorConsole =
      this.reflector.getAllAndOverride<boolean>(BUMPS_OPERATOR_CONSOLE_KEY, targets) === true;

    // The handler runs inside the tracking scope, so bumps its commits fire
    // are this request's to await.
    const bumps: RequestBumps = { pending: [] };
    const handled = new Observable<unknown>((subscriber) =>
      this.epochs.trackRequestBumps(bumps, () => next.handle().subscribe(subscriber)),
    );
    const settle = async () => {
      await Promise.all([
        this.epochs.settleRequestBumps(bumps),
        this.bumpFor(request, operatorConsole),
      ]);
    };
    return handled.pipe(
      concatMap((data) => from(settle().then(() => data))),
      catchError((error) => {
        // A pipe or limiter refused before the handler: nothing was written,
        // so nothing of the caller's is bumped (any hook bump is awaited).
        if (error instanceof HttpException) {
          return from(this.epochs.settleRequestBumps(bumps)).pipe(
            concatMap(() => throwError(() => error)),
          );
        }
        return from(settle()).pipe(concatMap(() => throwError(() => error)));
      }),
    );
  }

  private async bumpFor(request: Record<string, unknown>, operatorConsole: boolean) {
    const session = request[SESSION_REQUEST_KEY] as { organizationId?: unknown } | undefined;
    if (typeof session?.organizationId === 'string' && session.organizationId.length > 0) {
      await this.epochs.bump(
        session.organizationId,
        ...ORGANIZATION_EPOCH_SCOPES,
        ...(operatorConsole ? (['operator'] as const) : []),
      );
    }
    const operator = request[OPERATOR_REQUEST_KEY] as { operatorId?: unknown } | undefined;
    if (typeof operator?.operatorId === 'string') {
      await this.epochs.bump(null, 'operator', 'shared');
    }
  }
}
