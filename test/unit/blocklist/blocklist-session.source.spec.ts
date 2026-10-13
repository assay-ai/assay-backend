import { ExecutionContext } from '@nestjs/common';

import { AccountErrorCode } from '@modules/account/errors/account.errors';
import { AuthErrorCode } from '@modules/auth/errors/auth.errors';
import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { BlocklistSessionSource } from '@modules/blocklist/services/blocklist-session.source';
import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { McpController } from '@modules/mcp/controllers/mcp.controller';
import { McpCallerKind, McpSession, McpSessionPort } from '@modules/mcp/ports/mcp-session.port';
import { SESSION_REQUEST_KEY, SessionAuthGuard } from '@shared/auth';

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

describe('SessionAuthGuard on a blocked person', () => {
  function context(method: string) {
    const request: Record<string, unknown> = { method, headers: { authorization: 'Bearer t' } };
    return {
      request,
      context: {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
    };
  }

  const blockedHuman = (role: BlockedRole, subjectKind: BlockSubjectKind) =>
    new SessionAuthGuard(
      sourceOf(session(McpCallerKind.HUMAN, { blocked: { role, subjectKind } })),
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
    const guard = new SessionAuthGuard(sourceOf(session(McpCallerKind.HUMAN)));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
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
    );

    await expect(
      controller.handle({ headers: { authorization: 'Bearer t' } } as never, {} as never),
    ).rejects.toMatchObject({ errorCode: AccountErrorCode.ACCOUNT_BLOCKED });
    expect(create).not.toHaveBeenCalled();
  });
});
