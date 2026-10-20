import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, throwError } from 'rxjs';
import { catchError, concatMap } from 'rxjs/operators';

import { BLOCKED_SESSION_READ_ONLY_METADATA } from '@shared/auth/blocked-session-read-only.decorator';
import { OPERATOR_REQUEST_KEY } from '@shared/auth/operator-request.key';
import { SESSION_REQUEST_KEY } from '@shared/auth/session-request.key';
import {
  ORGANIZATION_EPOCH_SCOPES,
  TenantEpochService,
} from '@shared/cache/redis-cache/tenant-epoch.service';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The caller's own write is visible on their next read, whatever it touched.
 *
 * After a signed-in `POST`/`PUT`/`PATCH`/`DELETE` returns — its handler has
 * committed by then — every per-organization epoch of the caller's
 * organization is bumped before the response leaves, so no cached read of
 * that organization (`@TenantCache`) can answer with the pre-write body, and
 * the global operator scope moves with it. An operator's write bumps the
 * global operator and shared scopes. A failed write bumps too:
 * a handler can commit part of its work before it throws.
 *
 * This is the backstop that keeps "the user sees their own write at once"
 * true without every write path naming the scopes it touched. It does not
 * cover a write that changes ANOTHER organization's data (a dispute the
 * provider must answer, an operator decision, a credit to a provider) nor
 * work done by MCP calls, workers and the scheduler: those bump where they
 * write, or rely on the cached route's short TTL.
 *
 * A `POST` that only reads (`@BlockedSessionReadOnly`) bumps nothing.
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
    if (this.reflector.get<boolean>(BLOCKED_SESSION_READ_ONLY_METADATA, context.getHandler())) {
      return next.handle();
    }
    return next.handle().pipe(
      concatMap((data) => from(this.bumpFor(request).then(() => data))),
      catchError((error) =>
        from(this.bumpFor(request)).pipe(concatMap(() => throwError(() => error))),
      ),
    );
  }

  private async bumpFor(request: Record<string, unknown>): Promise<void> {
    const session = request[SESSION_REQUEST_KEY] as { organizationId?: unknown } | undefined;
    if (typeof session?.organizationId === 'string' && session.organizationId.length > 0) {
      // The operator console lists what organizations file (disputes, tool
      // requests, reports, reviews), so its global scope moves too.
      await this.epochs.bump(session.organizationId, ...ORGANIZATION_EPOCH_SCOPES, 'operator');
    }
    const operator = request[OPERATOR_REQUEST_KEY] as { operatorId?: unknown } | undefined;
    if (typeof operator?.operatorId === 'string') {
      await this.epochs.bump(null, 'operator', 'shared');
    }
  }
}
