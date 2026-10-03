import 'reflect-metadata';

import { Reflector } from '@nestjs/core';

import { OperatorRole } from '@modules/operator/domain/override-register';
import { OperatorRolesGuard } from '@shared/auth/operator-roles.guard';
import { RequireRoles } from '@shared/auth/require-roles.decorator';

import { expectErrorCode } from '../helpers/expect-error-code';
import { fakeExecutionContext } from './helpers/fake-execution-context';

/**
 * `OperatorRolesGuard`.
 *
 * The important case is the last one: a handler that mutates something and
 * never got a `@RequireRoles` annotation must be refused, not treated as
 * "open to any authenticated operator". Everything else here is the ordinary
 * allow/deny check the metadata is for.
 */
describe('OperatorRolesGuard', () => {
  const reflector = new Reflector();
  const guard = new OperatorRolesGuard(reflector);

  function handlerRequiring(...roles: OperatorRole[]): () => void {
    const handler = () => undefined;
    RequireRoles(...roles)(handler);
    return handler;
  }

  const bareHandler = (): void => undefined;

  it('passes when the session holds one of the required roles', () => {
    const handler = handlerRequiring(OperatorRole.ADJ, OperatorRole.ADJL);
    const context = fakeExecutionContext({
      handler,
      method: 'POST',
      operator: { roles: [OperatorRole.ADJ] },
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('refuses when the session holds none of the required roles', () => {
    const handler = handlerRequiring(OperatorRole.ADJL);
    const context = fakeExecutionContext({
      handler,
      method: 'POST',
      operator: { roles: [OperatorRole.SUP] },
    });

    expectErrorCode(() => guard.canActivate(context), 'OPERATOR_ROLE_REQUIRED');
  });

  it('refuses a POST handler with no @RequireRoles metadata — fail closed', () => {
    const context = fakeExecutionContext({
      handler: bareHandler,
      method: 'POST',
      operator: { roles: [OperatorRole.ADJL] },
    });

    expectErrorCode(() => guard.canActivate(context), 'OPERATOR_ROLE_REQUIRED');
  });

  it.each(['PUT', 'PATCH', 'DELETE'])(
    'refuses a %s handler with no @RequireRoles metadata too',
    (method) => {
      const context = fakeExecutionContext({
        handler: bareHandler,
        method,
        operator: { roles: [OperatorRole.ADJL] },
      });

      expectErrorCode(() => guard.canActivate(context), 'OPERATOR_ROLE_REQUIRED');
    },
  );

  it('allows a read-only (GET) handler with no @RequireRoles metadata', () => {
    const context = fakeExecutionContext({
      handler: bareHandler,
      method: 'GET',
      operator: { roles: [] },
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('refuses a role-annotated handler when no session is attached at all', () => {
    const handler = handlerRequiring(OperatorRole.ADJL);
    const context = fakeExecutionContext({ handler, method: 'POST', operator: undefined });

    expectErrorCode(() => guard.canActivate(context), 'OPERATOR_ROLE_REQUIRED');
  });
});
