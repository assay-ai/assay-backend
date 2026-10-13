import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { OperatorErrorCode } from '@modules/operator/errors/operator.errors';
import {
  OPERATOR_SESSION_SOURCE,
  OperatorSession,
  OperatorSessionPort,
} from '@modules/operator/ports/operator-session.port';
import { OperatorAuthThrottle } from '@modules/operator/services/operator-auth-throttle.service';
import { BaseError } from '@shared/errors/base.error';

import { OPERATOR_REQUEST_KEY } from './operator-request.key';

/**
 * Re-exported for the same reason `session-auth.guard.ts` re-exports
 * `SESSION_REQUEST_KEY`: `CurrentOperator` reads the same property this guard
 * writes, and importing it from here rather than duplicating the string
 * keeps the two from drifting apart.
 */
export { OPERATOR_REQUEST_KEY };

export interface RequestWithOperator extends Request {
  [OPERATOR_REQUEST_KEY]: OperatorSession;
}

/**
 * Authenticates an operator-console route, and attaches the resolved session
 * to the request.
 *
 * It is an **authenticator, not an authorizer** — same division of labour as
 * `SessionAuthGuard`. This guard answers "which operator, with which roles
 * and authority limit, is this bearer token" and stops there; it does not
 * know or care which of the register's rows the handler is about to perform.
 * That question is `OperatorRolesGuard`'s, and it runs second — always in
 * that order, because there is no session to check roles against until this
 * one has resolved one.
 *
 * Fails closed: `OperatorSessionPort.resolve` throws (never returns a null
 * session) on a missing token, an unknown token, or a suspended operator, and
 * that throw propagates through this guard unchanged.
 *
 * A presented token that is refused as invalid is counted against the client
 * address (`OperatorAuthThrottle`); an address over the limit is refused with
 * 429 before its token is looked at. A request with no token is not a guess
 * and is not counted.
 */
@Injectable()
export class OperatorAuthGuard implements CanActivate {
  constructor(
    @Inject(OPERATOR_SESSION_SOURCE) private readonly sessions: OperatorSessionPort,
    private readonly throttle: OperatorAuthThrottle,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithOperator>();
    const token = extractBearerToken(request);
    const ip = request.ip ?? 'unknown';

    if (token) await this.throttle.assertNotBlocked(ip);

    try {
      request[OPERATOR_REQUEST_KEY] = await this.sessions.resolve(token);
    } catch (error) {
      if (token && isCredentialInvalid(error)) await this.throttle.recordFailure(ip);
      throw error;
    }
    return true;
  }
}

function isCredentialInvalid(error: unknown): boolean {
  return (
    error instanceof BaseError && error.errorCode === OperatorErrorCode.OPERATOR_CREDENTIAL_INVALID
  );
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}
