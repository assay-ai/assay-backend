import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { AuthErrors } from '@modules/auth/errors/auth.errors';
import { sessionBlockedError } from '@modules/blocklist/services/blocklist-session.source';
import {
  MCP_SESSION_SOURCE,
  McpCallerKind,
  McpSession,
  McpSessionPort,
} from '@modules/mcp/ports/mcp-session.port';

import { AGENT_SCOPE_METADATA, AgentScope } from './agent-scope';

import { extractBearerToken } from './bearer-token';
import {
  ALLOWED_WHILE_BLOCKED_METADATA,
  BLOCKED_SESSION_READ_ONLY_METADATA,
} from './blocked-session-read-only.decorator';
import { SESSION_REQUEST_KEY } from './session-request.key';

/**
 * The property the resolved session is attached to on the request object.
 *
 * Defined in `session-request.key.ts` and re-exported here, so that
 * `HttpCacheInterceptor` can read the same property without importing this
 * guard — and so the two cannot drift apart. They did once: the interceptor
 * keyed its cache on `request.user`, which nothing on this surface sets, and
 * the resulting tenant-less key served one organization another's response
 * body.
 */
export { SESSION_REQUEST_KEY };

export interface RequestWithSession extends Request {
  [SESSION_REQUEST_KEY]: McpSession;
}

/**
 * Authenticates a non-MCP HTTP route through the same credential store MCP
 * uses, and attaches the resolved session to the request.
 *
 * `McpSessionPort` is named for its first caller (`tools/call`), not for MCP
 * itself — it answers one question that any authenticated route needs
 * answered the same way: *given a bearer token, which organization, which
 * agent, and which on-chain account is this request allowed to spend or read
 * as?* The receipts and balances endpoints this guard protects are read paths
 * over exactly that agent's money, so they resolve the token through the same
 * port rather than inventing a second notion of "who is calling" that could
 * drift from the one MCP enforces on the write path.
 *
 * **The session-source swap.** `McpSessionPort` can be bound to
 * `ConfigMcpSessionSource`, a configuration file standing in for
 * Privy-issued session tokens. When Privy is the source, only the provider bound to `MCP_SESSION_SOURCE` changes — this guard,
 * and every controller that reads `organizationId` / `agentAccount` off
 * `@CurrentSession()`, does not, because the contract it depends on
 * (`McpSessionPort.resolve`) is the thing the swap replaces the
 * implementation of, not the shape of.
 *
 * **Why this must be the only source of `organizationId`.** An endpoint that
 * read `organizationId` from a query string or request body would let any
 * caller with a valid-looking token read another tenant's balances and
 * receipts by simply naming a different id — the exact class of bug
 * `OrganizationScopedRepository` exists to make impossible at the database
 * layer. This guard is what makes it impossible at the HTTP layer too:
 * `organizationId` and `agentAccount` are never accepted as input, only
 * resolved from the credential.
 *
 * Fails closed: `McpSessionPort.resolve` throws (never returns a null
 * session) on a missing or unknown token, and that throw propagates through
 * this guard to `AllExceptionsFilter` unchanged.
 *
 * **A blocked account reads, and does nothing else.** The session source
 * refuses a blocked machine credential outright and marks a blocked person's
 * session (`McpSession.blocked`). Such a session passes here on `GET` and
 * `HEAD` only — the dashboard can still show the account its own data and the
 * block — and every other method is refused with the block's own code, except
 * on a route marked `@BlockedSessionReadOnly()` (a `POST` that only reads) or
 * `@AllowedWhileBlocked()` (a write that only revokes authority). A
 * read that hands out something spendable (`GET /escrow/next-seq` issues a
 * voucher seq) refuses again where it does so.
 *
 * **An agent credential is refused unless the route names its scope.** A
 * person's session (`HUMAN`, or a `CONFIG` token marked as a person's) passes
 * on every route. Any other session passes only on a route marked
 * `@RequireAgentScope(scope)` and only when it holds that scope: a route
 * without the mark is `AUTH_HUMAN_SESSION_REQUIRED` for every key, and a key
 * without the scope is `AUTH_SCOPE_MISSING` naming it. Deny by default: a new
 * route is a person's until someone opens it on purpose. The check runs in
 * this guard, before the tenant cache can answer.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    @Inject(MCP_SESSION_SOURCE) private readonly sessions: McpSessionPort,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const session = await this.sessions.resolve(extractBearerToken(request));
    this.assertAgentScope(context, session);
    if (
      session.blocked &&
      !READ_METHODS.has(request.method.toUpperCase()) &&
      !this.isReadOnlyRoute(context)
    ) {
      throw sessionBlockedError(session.blocked);
    }
    request[SESSION_REQUEST_KEY] = session;
    return true;
  }

  private assertAgentScope(context: ExecutionContext, session: McpSession): void {
    if (PERSON_KINDS.has(session.callerKind)) return;
    const required = this.reflector.getAllAndOverride<AgentScope | undefined>(
      AGENT_SCOPE_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!required) throw AuthErrors.humanSessionRequired();
    if (!(session.scopes ?? []).includes(required)) {
      throw AuthErrors.scopeMissing({ requiredScope: required });
    }
  }

  private isReadOnlyRoute(context: ExecutionContext): boolean {
    return [BLOCKED_SESSION_READ_ONLY_METADATA, ALLOWED_WHILE_BLOCKED_METADATA].some(
      (key) =>
        this.reflector.getAllAndOverride<boolean | undefined>(key, [
          context.getHandler(),
          context.getClass(),
        ]) === true,
    );
  }
}

/** Sessions no scope limits: the same allow-list as `HumanSessionGuard`. */
const PERSON_KINDS: ReadonlySet<McpCallerKind> = new Set([
  McpCallerKind.HUMAN,
  McpCallerKind.CONFIG,
]);

/** The methods a blocked person's session may still use. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
