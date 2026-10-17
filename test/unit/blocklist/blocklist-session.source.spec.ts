import { Controller, ExecutionContext, Post } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AccountErrorCode } from '@modules/account/errors/account.errors';
import { AuthErrorCode } from '@modules/auth/errors/auth.errors';
import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { BlocklistSessionSource } from '@modules/blocklist/services/blocklist-session.source';
import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { McpController } from '@modules/mcp/controllers/mcp.controller';
import { McpCallerKind, McpSession, McpSessionPort } from '@modules/mcp/ports/mcp-session.port';
import { ProviderSlashRequestsController } from '@modules/slash/controllers/provider-slash-requests.controller';
import { ProviderSlashProposalsController } from '@modules/slash/controllers/provider-slash-proposals.controller';
import { AgentCredentialsController } from '@modules/account/controllers/agent-credentials.controller';
import { EscrowDelegatesController } from '@modules/settlement/controllers/escrow-delegates.controller';
import {
  ALLOWED_WHILE_BLOCKED_METADATA,
  BLOCKED_SESSION_READ_ONLY_METADATA,
  BlockedSessionReadOnly,
  SESSION_REQUEST_KEY,
  SessionAuthGuard,
} from '@shared/auth';

import { blocklistOf } from '../helpers/blocklist';

const ORG = '08773f92-21cd-4e53-8348-d3ef1dcc8378';
const CHAIN = 'eip155:84532' as ChainId;
const ACCOUNT = `${CHAIN}:0x976ea74026e726554db657fa54763abd0c3a0aa9` as AccountId;
const DELEGATE = `${CHAIN}:0x14dc79964da2c08b23698b3d3cc7ca32193d9955` as AccountId;

function session(callerKind: McpCallerKind, overrides: Partial<McpSession> = {}): McpSession {
  return {
    credentialId: 'cred-1',
    organizationId: ORG,
    agentId: 'agent-1',
    agentAccount: ACCOUNT,
    chainId: CHAIN,
    label: null,
    callerKind,
    delegateAccount: null,
    ...overrides,
  };
}

const sourceOf = (resolved: McpSession): McpSessionPort => ({ resolve: async () => resolved });

describe('BlocklistSessionSource', () => {
  it('passes an unblocked session through untouched', async () => {
    const original = session(McpCallerKind.AGENT);
    const source = new BlocklistSessionSource(sourceOf(original), blocklistOf());

    await expect(source.resolve('token')).resolves.toBe(original);
  });

  it.each([McpCallerKind.AGENT])(
    'refuses a %s credential of a blocked organization with AUTH_ORGANIZATION_SUSPENDED',
    async (kind) => {
      const source = new BlocklistSessionSource(
        sourceOf(session(kind)),
        blocklistOf({ kind: BlockSubjectKind.ORGANIZATION, subject: ORG }),
      );

      await expect(source.resolve('token')).rejects.toMatchObject({
        errorCode: AuthErrorCode.AUTH_ORGANIZATION_SUSPENDED,
        statusCode: 403,
      });
    },
  );

  it('refuses an agent whose own account is blocked with ACCOUNT_BLOCKED (payer)', async () => {
    const source = new BlocklistSessionSource(
      sourceOf(session(McpCallerKind.AGENT)),
      blocklistOf({ kind: BlockSubjectKind.WALLET, subject: ACCOUNT }),
    );

    await expect(source.resolve('token')).rejects.toMatchObject({
      errorCode: AccountErrorCode.ACCOUNT_BLOCKED,
      context: { role: BlockedRole.PAYER },
    });
  });

  it('refuses an agent whose bound delegate key is blocked', async () => {
    const source = new BlocklistSessionSource(
      sourceOf(session(McpCallerKind.AGENT, { delegateAccount: DELEGATE })),
      blocklistOf({ kind: BlockSubjectKind.WALLET, subject: DELEGATE }),
    );

    await expect(source.resolve('token')).rejects.toMatchObject({
      errorCode: AccountErrorCode.ACCOUNT_BLOCKED,
      context: { role: BlockedRole.DELEGATE },
    });
  });

  it.each([McpCallerKind.HUMAN, McpCallerKind.CONFIG])(
    'gives a blocked %s session, marked, so the dashboard can still read',
    async (kind) => {
      const source = new BlocklistSessionSource(
        sourceOf(session(kind)),
        blocklistOf({ kind: BlockSubjectKind.ORGANIZATION, subject: ORG }),
      );

      await expect(source.resolve('token')).resolves.toMatchObject({
        organizationId: ORG,
        blocked: { role: BlockedRole.ORGANIZATION, subjectKind: BlockSubjectKind.ORGANIZATION },
      });
    },
  );

  it('lets the inner refusal through unchanged', async () => {
    const failing: McpSessionPort = {
      resolve: async () => {
        throw new Error('not my token');
      },
    };
    const source = new BlocklistSessionSource(failing, blocklistOf());
    await expect(source.resolve(null)).rejects.toThrow('not my token');
  });
});

/** A controller with one route marked read-only and one not, for the guard below. */
@Controller('test')
class RoutesUnderTest {
  @Post('read-only')
  @BlockedSessionReadOnly()
  readOnly(): void {}

  @Post('write')
  write(): void {}
}

function context(method: string, handler: keyof RoutesUnderTest = 'write') {
  const request: Record<string, unknown> = { method, headers: { authorization: 'Bearer t' } };
  return {
    request,
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => RoutesUnderTest.prototype[handler],
      getClass: () => RoutesUnderTest,
    } as unknown as ExecutionContext,
  };
}

describe('SessionAuthGuard on a blocked person', () => {
  const blockedHuman = (role: BlockedRole, subjectKind: BlockSubjectKind) =>
    new SessionAuthGuard(
      sourceOf(session(McpCallerKind.HUMAN, { blocked: { role, subjectKind } })),
      new Reflector(),
    );

  it.each(['GET', 'HEAD'])('lets a %s through, with the session attached', async (method) => {
    const { request, context: ctx } = context(method);
    await expect(
      blockedHuman(BlockedRole.ORGANIZATION, BlockSubjectKind.ORGANIZATION).canActivate(ctx),
    ).resolves.toBe(true);
    expect(request[SESSION_REQUEST_KEY]).toMatchObject({ organizationId: ORG });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses a %s with the organization code',
    async (method) => {
      const { request, context: ctx } = context(method);
      await expect(
        blockedHuman(BlockedRole.ORGANIZATION, BlockSubjectKind.ORGANIZATION).canActivate(ctx),
      ).rejects.toMatchObject({ errorCode: AuthErrorCode.AUTH_ORGANIZATION_SUSPENDED });
      expect(request[SESSION_REQUEST_KEY]).toBeUndefined();
    },
  );

  it('refuses a write by a person whose wallet is blocked with ACCOUNT_BLOCKED', async () => {
    const { context: ctx } = context('POST');
    await expect(
      blockedHuman(BlockedRole.PAYER, BlockSubjectKind.WALLET).canActivate(ctx),
    ).rejects.toMatchObject({
      errorCode: AccountErrorCode.ACCOUNT_BLOCKED,
      context: { role: BlockedRole.PAYER },
    });
  });

  it('does not touch an unblocked session', async () => {
    const { context: ctx } = context('POST');
    const guard = new SessionAuthGuard(sourceOf(session(McpCallerKind.HUMAN)), new Reflector());
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});

describe('SessionAuthGuard on a route marked @BlockedSessionReadOnly', () => {
  it.each([
    [BlockedRole.ORGANIZATION, BlockSubjectKind.ORGANIZATION],
    [BlockedRole.PAYER, BlockSubjectKind.WALLET],
  ])(
    'lets a blocked person (%s) POST to it, with the session attached',
    async (role, subjectKind) => {
      const { request, context: ctx } = context('POST', 'readOnly');
      const guard = new SessionAuthGuard(
        sourceOf(session(McpCallerKind.HUMAN, { blocked: { role, subjectKind } })),
        new Reflector(),
      );
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(request[SESSION_REQUEST_KEY]).toMatchObject({
        organizationId: ORG,
        blocked: { role },
      });
    },
  );

  it('still refuses the same person on an unmarked POST of the same controller', async () => {
    const { context: ctx } = context('POST', 'write');
    const guard = new SessionAuthGuard(
      sourceOf(
        session(McpCallerKind.HUMAN, {
          blocked: { role: BlockedRole.ORGANIZATION, subjectKind: BlockSubjectKind.ORGANIZATION },
        }),
      ),
      new Reflector(),
    );
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      errorCode: AuthErrorCode.AUTH_ORGANIZATION_SUSPENDED,
    });
  });

  it('still refuses a machine credential of a blocked organization outright', async () => {
    const { request, context: ctx } = context('POST', 'readOnly');
    const guard = new SessionAuthGuard(
      new BlocklistSessionSource(
        sourceOf(session(McpCallerKind.AGENT)),
        blocklistOf({ kind: BlockSubjectKind.ORGANIZATION, subject: ORG }),
      ),
      new Reflector(),
    );
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      errorCode: AuthErrorCode.AUTH_ORGANIZATION_SUSPENDED,
      statusCode: 403,
    });
    expect(request[SESSION_REQUEST_KEY]).toBeUndefined();
  });

  it('marks the penalties lookup, the read-only POST a blocked provider needs', () => {
    expect(
      new Reflector().get(
        BLOCKED_SESSION_READ_ONLY_METADATA,
        ProviderSlashRequestsController.prototype.lookup,
      ),
    ).toBe(true);
  });
});

describe('the revoke routes a blocked person still needs (audit E-5)', () => {
  const blocked = (role: BlockedRole, subjectKind: BlockSubjectKind) =>
    new SessionAuthGuard(
      sourceOf(session(McpCallerKind.HUMAN, { blocked: { role, subjectKind } })),
      new Reflector(),
    );
  const on = (controller: { prototype: object }, handler: string, method: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ method, headers: { authorization: 'Bearer t' } }),
      }),
      getHandler: () => (controller.prototype as unknown as Record<string, unknown>)[handler],
      getClass: () => controller,
    }) as unknown as ExecutionContext;

  it.each([
    [EscrowDelegatesController, 'revokeIntent', 'POST'],
    [EscrowDelegatesController, 'revoke', 'POST'],
    [AgentCredentialsController, 'revoke', 'DELETE'],
    // Review S-8: an objection only takes authority away from the platform.
    [ProviderSlashProposalsController, 'dispute', 'POST'],
    [ProviderSlashProposalsController, 'acknowledge', 'POST'],
  ] as const)('lets a blocked person through %p.%s', async (controller, handler, method) => {
    for (const [role, kind] of [
      [BlockedRole.ORGANIZATION, BlockSubjectKind.ORGANIZATION],
      [BlockedRole.PAYER, BlockSubjectKind.WALLET],
    ] as const) {
      await expect(blocked(role, kind).canActivate(on(controller, handler, method))).resolves.toBe(
        true,
      );
    }
    expect(
      new Reflector().get(
        ALLOWED_WHILE_BLOCKED_METADATA,
        (controller.prototype as unknown as Record<string, () => void>)[handler],
      ),
    ).toBe(true);
    // A write that only revokes authority is not "read-only".
    expect(
      new Reflector().get(
        BLOCKED_SESSION_READ_ONLY_METADATA,
        (controller.prototype as unknown as Record<string, () => void>)[handler],
      ),
    ).toBeUndefined();
  });

  it('still refuses granting authority: authorizing a delegate or creating a credential', async () => {
    const guard = blocked(BlockedRole.PAYER, BlockSubjectKind.WALLET);
    for (const [controller, handler] of [
      [EscrowDelegatesController, 'authorizeIntent'],
      [EscrowDelegatesController, 'authorize'],
      [AgentCredentialsController, 'create'],
    ] as const) {
      expect((controller.prototype as unknown as Record<string, unknown>)[handler]).toBeDefined();
      await expect(guard.canActivate(on(controller, handler, 'POST'))).rejects.toMatchObject({
        errorCode: AccountErrorCode.ACCOUNT_BLOCKED,
      });
    }
  });
});

describe('the MCP endpoint, for a blocked person', () => {
  it('refuses the request before a server is built', async () => {
    const create = jest.fn();
    const controller = new McpController(
      sourceOf(
        session(McpCallerKind.HUMAN, {
          blocked: { role: BlockedRole.PAYER, subjectKind: BlockSubjectKind.WALLET },
        }),
      ),
      { create } as never,
      { resolve: jest.fn() } as never,
      { resolve: jest.fn() } as never,
      { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' },
    );

    await expect(
      controller.handle(
        { method: 'POST', originalUrl: '/', headers: { authorization: 'Bearer t' } } as never,
        {} as never,
      ),
    ).rejects.toMatchObject({ errorCode: AccountErrorCode.ACCOUNT_BLOCKED });
    expect(create).not.toHaveBeenCalled();
  });
});
