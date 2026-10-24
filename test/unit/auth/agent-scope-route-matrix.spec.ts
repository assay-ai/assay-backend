import 'reflect-metadata';

import { readdirSync, statSync } from 'fs';
import { join } from 'path';

import { ExecutionContext, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';

import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { McpCallerKind, McpSession, McpSessionPort } from '@modules/mcp/ports/mcp-session.port';
import { AGENT_SCOPES, AGENT_SCOPE_METADATA, AgentScope } from '@shared/auth/agent-scope';
import { SessionAuthGuard } from '@shared/auth/session-auth.guard';

/**
 * Agent key scopes, route by route, against the real controller metadata.
 *
 * Every route behind `SessionAuthGuard` is either open to an agent credential
 * through exactly one scope (the table below, which is the whole agent
 * surface) or a person's only. A route added later without
 * `@RequireAgentScope` is a person's, and one added WITH it is a red test
 * here until the table names it: the agent surface only grows on purpose.
 *
 * Then each route is driven through `SessionAuthGuard` itself: a scoped route
 * admits a key holding its scope and refuses one holding every other scope
 * with `AUTH_SCOPE_MISSING`; a person-only route refuses a key holding every
 * scope with `AUTH_HUMAN_SESSION_REQUIRED`; a person passes everywhere.
 */
const AGENT_ROUTES: Readonly<Record<string, AgentScope>> = {
  // tools:call — the MCP host itself is checked in `McpController` (its own spec).
  'GET /free-quota': AgentScope.TOOLS_CALL,
  'GET /agents/:agentId/access': AgentScope.TOOLS_CALL,

  // payments
  'GET /agents/me/delegate': AgentScope.PAYMENTS,
  'GET /agents/me/delegate/status': AgentScope.PAYMENTS,
  'POST /agents/me/delegate/challenge': AgentScope.PAYMENTS,
  'POST /agents/me/delegate': AgentScope.PAYMENTS,
  'GET /escrow/next-seq': AgentScope.PAYMENTS,
  'GET /escrow/debts': AgentScope.PAYMENTS,
  'POST /escrow/debts/:intentId/voucher-intent': AgentScope.PAYMENTS,
  'POST /escrow/debts/:intentId/voucher': AgentScope.PAYMENTS,

  // activity:read
  'GET /escrow': AgentScope.ACTIVITY_READ,
  'GET /balances': AgentScope.ACTIVITY_READ,
  'GET /holds': AgentScope.ACTIVITY_READ,
  'GET /tool-calls': AgentScope.ACTIVITY_READ,
  'GET /tool-calls/:intentId': AgentScope.ACTIVITY_READ,
  'GET /receipts/summary': AgentScope.ACTIVITY_READ,
  'GET /receipts/summary/daily': AgentScope.ACTIVITY_READ,
  'GET /receipts/:intentId': AgentScope.ACTIVITY_READ,
  'GET /verdicts': AgentScope.ACTIVITY_READ,
  'GET /verdicts/:id': AgentScope.ACTIVITY_READ,
  'GET /verdicts/:id/evidence': AgentScope.ACTIVITY_READ,
  'GET /spend-policy': AgentScope.ACTIVITY_READ,
  'GET /spend-policy/history': AgentScope.ACTIVITY_READ,
  'GET /call-disputes': AgentScope.ACTIVITY_READ,
  'GET /call-disputes/:id': AgentScope.ACTIVITY_READ,

  // reports:write
  'POST /call-disputes': AgentScope.REPORTS_WRITE,
  'POST /call-disputes/:id/withdraw': AgentScope.REPORTS_WRITE,
};

/**
 * Routes that MUST stay a person's whatever a key holds (owner decision): a
 * sample of the human-only list, so moving one into the table above is a
 * conscious edit of two places.
 */
const PERSON_ONLY_SAMPLE = [
  'GET /audit-log',
  'GET /notification-channels',
  'GET /notification-preferences',
  'GET /notifications',
  'GET /notifications/unread-count',
  'GET /notifications/:id/deliveries',
  'GET /overview',
  'GET /me/status',
  'GET /account/block-status',
  'GET /agents',
  'GET /agents/:agentId/credentials',
  'POST /agents/:agentId/credentials',
  'GET /toolsets',
  'GET /toolsets/:id',
  'GET /org/handle',
  'GET /catalogue/tools',
  'GET /tools',
  'POST /deposits',
  'GET /deposits',
  'GET /statements/balance',
  'GET /withheld',
  'GET /withdrawals',
  'POST /tool-requests',
  'GET /tool-requests',
  'GET /providers/me',
  'GET /providers/me/earnings',
  'GET /providers/me/calls/export',
  'GET /providers/me/verdicts',
  'GET /providers/me/call-disputes',
  'GET /escrow/delegates',
  'POST /escrow/delegates',
];

type ControllerClass = new (...args: never[]) => unknown;

const SRC = join(__dirname, '../../../src');

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) controllerFiles(full, out);
    else if (full.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

const CONTROLLERS: ControllerClass[] = controllerFiles(SRC)
  // A dynamic list of files: `require` is the only synchronous way to load it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  .flatMap((file) => Object.values(require(file) as Record<string, unknown>))
  .filter(
    (value): value is ControllerClass =>
      typeof value === 'function' && Reflect.hasMetadata(PATH_METADATA, value),
  );

interface Route {
  readonly key: string;
  readonly controller: ControllerClass;
  readonly handler: (...args: unknown[]) => unknown;
  readonly method: RequestMethod;
}

function guardsOf(target: object): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[];
}

function joinPath(...parts: (string | undefined)[]): string {
  const path = parts
    .map((part) => (part ?? '').replace(/^\/+|\/+$/g, ''))
    .filter((part) => part !== '')
    .join('/');
  return `/${path}`;
}

function routesOf(controller: ControllerClass): Route[] {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => prototype[name])
    .filter((fn): fn is (...args: unknown[]) => unknown => typeof fn === 'function')
    .filter((fn) => Reflect.hasMetadata(METHOD_METADATA, fn))
    .filter((fn) => [...guardsOf(controller), ...guardsOf(fn)].includes(SessionAuthGuard))
    .map((fn) => {
      const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod;
      const path = Reflect.getMetadata(PATH_METADATA, fn) as string | undefined;
      return {
        key: `${RequestMethod[method]} ${joinPath(base, path)}`,
        controller,
        handler: fn,
        method,
      };
    });
}

const ROUTES = CONTROLLERS.flatMap(routesOf);
const reflector = new Reflector();

function declaredScope(route: Route): AgentScope | undefined {
  return reflector.getAllAndOverride<AgentScope | undefined>(AGENT_SCOPE_METADATA, [
    route.handler,
    route.controller,
  ]);
}

const CHAIN = 'eip155:46630' as ChainId;

function session(callerKind: McpCallerKind, scopes: readonly AgentScope[]): McpSession {
  return {
    credentialId: '7b0c2f0e-3a5d-4d8e-9a4b-0f6f2d1c9e11',
    storedCredential: true,
    organizationId: '08773f92-21cd-4e53-8348-d3ef1dcc8378',
    agentId: 'dcff5fef-5f11-4bc6-8d85-d64e38da6e39',
    agentAccount: `${CHAIN}:0x18103e1D79257c695B2FBbd4b346CD2Ba7927296` as AccountId,
    chainId: CHAIN,
    label: null,
    callerKind,
    paymentsAllowed: scopes.includes(AgentScope.PAYMENTS),
    scopes,
  };
}

function contextFor(route: Route): ExecutionContext {
  const request = {
    method: RequestMethod[route.method],
    headers: { authorization: 'Bearer assay_sk_live_test' },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => route.handler,
    getClass: () => route.controller,
  } as unknown as ExecutionContext;
}

async function run(route: Route, caller: McpSession): Promise<string> {
  const sessions: McpSessionPort = { resolve: () => Promise.resolve(caller) };
  const guard = new SessionAuthGuard(sessions, reflector);
  try {
    await guard.canActivate(contextFor(route));
    return 'ALLOWED';
  } catch (error) {
    return (error as { errorCode?: string }).errorCode ?? String(error);
  }
}

describe('agent key scopes: the route matrix (deny by default)', () => {
  it('finds the session surface (the test is meaningless if it does not)', () => {
    expect(ROUTES.length).toBeGreaterThan(150);
    expect(new Set(ROUTES.map((route) => route.key)).size).toBe(ROUTES.length);
  });

  it('opens exactly the table above to agent credentials, each through one scope', () => {
    const declared = Object.fromEntries(
      ROUTES.filter((route) => declaredScope(route) !== undefined).map((route) => [
        route.key,
        declaredScope(route),
      ]),
    );
    expect(declared).toEqual(AGENT_ROUTES);
  });

  it('keeps the owner-named routes person-only', () => {
    const keys = new Set(ROUTES.map((route) => route.key));
    for (const key of PERSON_ONLY_SAMPLE) {
      expect(keys).toContain(key);
      expect(AGENT_ROUTES[key]).toBeUndefined();
    }
  });

  describe.each(ROUTES.map((route) => [route.key, route] as const))('%s', (_key, route) => {
    const required = declaredScope(route);

    if (required) {
      it(`admits a key with ${required}, refuses one without it (AUTH_SCOPE_MISSING)`, async () => {
        expect(await run(route, session(McpCallerKind.AGENT, [required]))).toBe('ALLOWED');
        const others = AGENT_SCOPES.filter((scope) => scope !== required);
        expect(await run(route, session(McpCallerKind.AGENT, others))).toBe('AUTH_SCOPE_MISSING');
        expect(await run(route, session(McpCallerKind.AGENT, []))).toBe('AUTH_SCOPE_MISSING');
      });
    } else {
      it('refuses a key holding every scope (AUTH_HUMAN_SESSION_REQUIRED)', async () => {
        expect(await run(route, session(McpCallerKind.AGENT, AGENT_SCOPES))).toBe(
          'AUTH_HUMAN_SESSION_REQUIRED',
        );
      });
    }

    it('admits a person, whatever scopes the session carries', async () => {
      expect(await run(route, session(McpCallerKind.HUMAN, []))).toBe('ALLOWED');
      expect(await run(route, session(McpCallerKind.CONFIG, []))).toBe('ALLOWED');
    });
  });
});
