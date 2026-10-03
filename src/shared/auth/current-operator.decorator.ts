import { ExecutionContext, createParamDecorator } from '@nestjs/common';

import { OperatorSession } from '@modules/operator/ports/operator-session.port';

import { OPERATOR_REQUEST_KEY, RequestWithOperator } from './operator-auth.guard';

/**
 * The session `OperatorAuthGuard` resolved for this request.
 *
 * A controller reads `operatorId` and `roles` off this and never off the
 * request body — see `operator-auth.guard.ts` for why. Requires
 * `OperatorAuthGuard` to have run first; used without it, this reads
 * `undefined`, which is why the guard and the decorator are always applied
 * together.
 */
export const CurrentOperator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OperatorSession => {
    const request = context.switchToHttp().getRequest<RequestWithOperator>();
    return request[OPERATOR_REQUEST_KEY];
  },
);
