import { ExecutionContext, createParamDecorator } from '@nestjs/common';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { RequestWithSession, SESSION_REQUEST_KEY } from './session-auth.guard';

/**
 * The session `SessionAuthGuard` resolved for this request.
 *
 * A controller reads `organizationId` and `agentAccount` off this and never
 * off the request body or query — see `session-auth.guard.ts` for why that is
 * not a style preference. Requires `SessionAuthGuard` to have run first; used
 * without it, this reads `undefined`, which is why the guard and the
 * decorator are always applied together.
 */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): McpSession => {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    return request[SESSION_REQUEST_KEY];
  },
);
