import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { AuthErrors } from '@modules/auth/errors/auth.errors';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpCallerKind } from '@modules/mcp/ports/mcp-session.port';

import { RequestWithSession, SESSION_REQUEST_KEY } from './session-auth.guard';

/**
 * Refuses an agent machine credential on a route only a person may use.
 *
 * Runs after {@link SessionAuthGuard} (class-level guards run before
 * method-level ones), which has already resolved and attached the session.
 * The controls this protects — spend policy, agent credentials, notification
 * routing — exist to bound and watch the agent, so the agent's own bearer
 * token must not be able to change them.
 *
 * **An allow-list, not a deny-list.** Only `HUMAN` and `CONFIG` (a config
 * token whose record is marked as a person's) pass; a kind
 * added later is refused until someone decides it should not be. A request
 * with no session at all means the guards were wired in the wrong order, and
 * is refused as unauthenticated rather than let through.
 */
@Injectable()
export class HumanSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const session = request[SESSION_REQUEST_KEY];

    if (!session) throw McpErrors.credentialInvalid();
    if (!HUMAN_KINDS.has(session.callerKind)) throw AuthErrors.humanSessionRequired();

    return true;
  }
}

const HUMAN_KINDS: ReadonlySet<McpCallerKind> = new Set([
  McpCallerKind.HUMAN,
  McpCallerKind.CONFIG,
]);

/**
 * The guard's allow-list, for a route that is open to both kinds but returns
 * more to a person (`GET /agents?include=`): one list, so the two cannot drift.
 */
export function isHumanCallerKind(callerKind: McpCallerKind): boolean {
  return HUMAN_KINDS.has(callerKind);
}
