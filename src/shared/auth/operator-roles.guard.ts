import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { OperatorRole } from '@modules/operator/domain/override-register';
import { OperatorErrors } from '@modules/operator/errors/operator.errors';

import { RequestWithOperator } from './operator-auth.guard';
import { REQUIRE_ROLES_METADATA } from './require-roles.decorator';

/** HTTP methods that change something. GET/HEAD/OPTIONS are read paths. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Authorizes an operator-console route against `@RequireRoles`.
 *
 * Runs after `OperatorAuthGuard`, never before — there is no session to check
 * roles against until that one has resolved one.
 *
 * ## The fail-closed case, and why it exists
 *
 * A handler that mutates something and carries **no** `@RequireRoles` is
 * refused, not allowed. The alternative — treating "no metadata" as "open to
 * any authenticated operator" — turns a forgotten annotation into a silent
 * privilege grant: an endpoint that was supposed to require `ADJL` and never
 * got the decorator would authenticate correctly and authorize everyone. That
 * is exactly the class of mistake the role model exists to make structurally
 * expensive, and it is cheaper to refuse a handler that forgot its roles than
 * to trust that every future handler remembers to declare them. A read-only
 * handler with no metadata is allowed through — the roster and the queue are
 * meant to be legible to any operator with a valid token; being blocked from
 * a decision needs a role, being blocked from a *list* would just be noise.
 */
@Injectable()
export class OperatorRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<OperatorRole[] | undefined>(
      REQUIRE_ROLES_METADATA,
      context.getHandler(),
    );
    const request = context.switchToHttp().getRequest<RequestWithOperator>();

    if (!required || required.length === 0) {
      if (MUTATING_METHODS.has(request.method.toUpperCase())) {
        throw OperatorErrors.roleRequired({ required: [] });
      }
      return true;
    }

    const session = request.operator;
    const held = session?.roles ?? [];
    if (!required.some((role) => held.includes(role))) {
      throw OperatorErrors.roleRequired({ required, held });
    }

    return true;
  }
}
