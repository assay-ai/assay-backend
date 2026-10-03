import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { OVERRIDE_CODE_METADATA, SKIP_OVERRIDE_METADATA } from '../decorators/override.decorator';
import { lookupOverride } from '../domain/override-register';
import { OperatorErrors } from '../errors/operator.errors';

/** Methods that change something. Everything else is a read. */
const MUTATING_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Refuses a mutating operator route that does not name a register row.
 *
 * The mechanical half of "every manual intervention appears in the override
 * register". `OverrideLogService` makes the
 * entry and the mutation atomic; this makes declaring one unavoidable. Neither
 * alone is the property asked for: the service can be bypassed by a handler
 * that simply does not call it, and this guard cannot make a handler that *does*
 * call it write a truthful entry.
 *
 * ## Fail closed, and why that is worth a 500 in production
 *
 * A handler with neither `@Override` nor `@OverrideExempt` is refused outright.
 * The alternative — let it through and log a warning — makes the register's
 * completeness depend on somebody reading logs, which is the failure this whole
 * goal exists to close. The cost is that forgetting the decorator breaks the
 * endpoint; that cost is paid once, by a developer, on the first call, in a
 * test.
 *
 * The refusal is `OPERATOR_UNKNOWN_OVERRIDE_CODE` (500) rather than a 4xx on
 * purpose: nothing the caller sent is wrong, and telling a client "you are
 * forbidden" when the truth is "we mis-wired this route" sends them looking for
 * a permission they do not need.
 */
@Injectable()
export class OperatorOverrideGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!MUTATING_METHODS.includes(request.method)) {
      return true;
    }

    const exemption = this.reflector.getAllAndOverride<string | undefined>(SKIP_OVERRIDE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exemption) {
      return true;
    }

    const code = this.reflector.getAllAndOverride<string | undefined>(OVERRIDE_CODE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!code) {
      throw OperatorErrors.unknownOverrideCode({
        code: `${request.method} ${request.path}`,
      });
    }

    // Checked here as well as in the service so a route citing a deleted row
    // fails on its first call rather than at the moment somebody tries to use
    // it during an incident.
    const definition = lookupOverride(code);
    if (!definition) {
      throw OperatorErrors.unknownOverrideCode({ code });
    }
    if (!definition.implemented) {
      throw OperatorErrors.overrideNotImplemented({ code });
    }

    return true;
  }
}
