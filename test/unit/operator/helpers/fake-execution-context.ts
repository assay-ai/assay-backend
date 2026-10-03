import { ExecutionContext } from '@nestjs/common';

/**
 * Just enough of `ExecutionContext` for a guard that only reads the handler
 * (for `Reflector.get`) and the HTTP request (for `method` and the attached
 * session). No class-level metadata, no RPC/WS context — `OperatorRolesGuard`
 * never asks for either.
 */
export function fakeExecutionContext(options: {
  handler: (...args: unknown[]) => unknown;
  method: string;
  operator?: unknown;
}): ExecutionContext {
  const request = { method: options.method, operator: options.operator };

  return {
    getHandler: () => options.handler,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}
