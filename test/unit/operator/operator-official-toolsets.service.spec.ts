import 'reflect-metadata';

import { OperatorModerationController } from '@modules/operator/controllers/operator-moderation.controller';
import { OperatorOfficialToolsetsController } from '@modules/operator/controllers/operator-official-toolsets.controller';
import {
  ApprovalMode,
  OVERRIDE_REGISTER,
  OperatorRole,
} from '@modules/operator/domain/override-register';
import { OperatorErrors } from '@modules/operator/errors/operator.errors';
import { OperatorApprover, OperatorSession } from '@modules/operator/ports/operator-session.port';
import {
  OperatorApprovalService,
  isApprovalQueued,
} from '@modules/operator/services/operator-approval.service';
import {
  OFFICIAL_PUBLISH_APPROVAL_ACTION,
  OperatorOfficialToolsetsService,
} from '@modules/operator/services/operator-official-toolsets.service';
import { ToolsetErrorCode, ToolsetErrors } from '@modules/toolset/errors/toolset.errors';
import { REQUIRE_ROLES_METADATA } from '@shared/auth/require-roles.decorator';

/**
 * P-13, the two-person publish of an official tool set (plan B), on the
 * contracts' P-10 pattern: refused for want of an approver and queued with
 * the Draft's hash; the approver's re-run publishes only that Draft; the
 * Draft is frozen while the request waits.
 */
const operator = (id: string, roles: OperatorRole[]): OperatorSession => ({
  operatorId: id,
  subject: `${id}@`,
  displayName: id,
  email: `${id}@example.test`,
  roles,
  authorityLimitMinor: null,
});
const POL = operator('op-pol', [OperatorRole.POL]);
const POLA: OperatorApprover = {
  ...operator('op-pola', [OperatorRole.POLA]),
  approvalId: 'approval-1',
};
const ID = '00000000-0000-4000-8000-000000000001';
const BODY = { reasonCode: 'OFFICIAL_SET', note: 'A curated set reviewed by the policy team.' };
const HASH = 'a'.repeat(64);
const DTO = { id: ID, slug: 'weather', entries: [] };

function build(options: { pending?: boolean; overrideFails?: boolean } = {}) {
  const official = {
    list: jest.fn(async () => [DTO]),
    get: jest.fn(async () => DTO),
    createDraft: jest.fn(async () => ID),
    updateDraft: jest.fn(async () => ({ liveChanged: false })),
    afterDraftChange: jest.fn(async () => undefined),
    assertPublishableNow: jest.fn(async () => undefined),
    contentHash: jest.fn(async () => HASH),
    publish: jest.fn(async () => ({
      toolsetId: ID,
      version: 1,
      changelog: 'First version: 1 tools.',
      diff: { added: [], removed: [], rulesChanged: [], settingsChanged: [] },
      contentHash: HASH,
      before: { visibility: 'PRIVATE', latestVersion: null },
    })),
    afterPublish: jest.fn(async () => undefined),
  };
  const logged: unknown[] = [];
  const overrides = {
    perform: jest.fn(
      async (
        context: { code: string; approver: unknown },
        mutation: (runner: unknown) => Promise<{ value: unknown; after: unknown }>,
      ) => {
        if (!context.approver) throw OperatorErrors.secondApproverRequired({ code: context.code });
        const result = await mutation({ manager: 'tx-manager' });
        if (options.overrideFails) throw new Error('override log entry failed');
        logged.push(result.after);
        return result.value;
      },
    ),
  };
  const saved: Record<string, unknown>[] = [];
  const approvalRows = {
    create: (row: Record<string, unknown>) => row,
    save: async (row: Record<string, unknown>) => {
      saved.push(row);
      return { ...row, id: 'approval-1' };
    },
    expireStale: async () => 0,
    findOne: async () => (options.pending ? { id: 'approval-1' } : null),
    find: async () =>
      options.pending
        ? [
            {
              id: 'approval-1',
              target: `toolset:${ID}`,
              requestedBy: POL.operatorId,
              expiresAt: new Date(Date.now() + 60_000),
            },
          ]
        : [],
  };
  const approvals = new OperatorApprovalService(approvalRows as never, {} as never, {} as never);
  const service = new OperatorOfficialToolsetsService(
    official as never,
    overrides as never,
    approvals,
    approvalRows as never,
    {
      manager: 'read-manager',
      transaction: async (work: (manager: unknown) => Promise<unknown>) => work('tx-manager'),
    } as never,
  );
  return { service, official, overrides, saved, logged };
}

const errorOf = async (work: () => Promise<unknown>) =>
  work().then(
    () => null,
    (error: { errorCode?: string; statusCode?: number }) => ({
      code: error.errorCode,
      status: error.statusCode,
    }),
  );

describe('OperatorOfficialToolsetsService — P-13 publish', () => {
  it('queues a request with the Draft’s hash, and publishes nothing', async () => {
    const { service, official, saved } = build();
    const result = await service.publish(POL, ID, BODY, 'req-1');

    expect(isApprovalQueued(result)).toBe(true);
    expect(saved).toEqual([
      expect.objectContaining({
        action: OFFICIAL_PUBLISH_APPROVAL_ACTION,
        target: `toolset:${ID}`,
        payload: { toolsetId: ID, contentHash: HASH, body: BODY },
        requestedBy: POL.operatorId,
      }),
    ]);
    expect(official.publish).not.toHaveBeenCalled();
    expect(official.afterPublish).not.toHaveBeenCalled();
  });

  it('refuses a request no one could approve before queueing anything', async () => {
    const { service, official, saved } = build();
    official.assertPublishableNow.mockRejectedValueOnce(
      ToolsetErrors.notPublishable({ reason: 'a tool set needs at least one tool' }),
    );
    expect(await errorOf(() => service.publish(POL, ID, BODY, null))).toEqual({
      code: ToolsetErrorCode.TOOLSET_NOT_PUBLISHABLE,
      status: 400,
    });
    expect(saved).toEqual([]);
  });

  it('the approver’s re-run publishes exactly the requested Draft, in the log’s transaction', async () => {
    const { service, official, logged } = build();
    await service.publish(POL, ID, { ...BODY, changelog: 'Hand-picked.' }, 'req-2', POLA, HASH);

    expect(official.publish).toHaveBeenCalledWith('tx-manager', ID, {
      changelog: 'Hand-picked.',
      expectedHash: HASH,
    });
    expect(logged).toEqual([expect.objectContaining({ latestVersion: 1, contentHash: HASH })]);
    expect(official.afterPublish).toHaveBeenCalledTimes(1);
  });

  it('a queued payload with no hash matches no Draft', async () => {
    const { service, official } = build();
    await service.publish(POL, ID, BODY, null, POLA, undefined);
    expect(official.publish).toHaveBeenCalledWith('tx-manager', ID, {
      changelog: undefined,
      expectedHash: '',
    });
  });

  it('runs the approval handler registered for toolset.official_publish as P-13', async () => {
    const { service, official } = build();
    const handlers = (
      service as unknown as {
        approvals: { handlers: Map<string, { code: string; run: (...a: unknown[]) => unknown }> };
      }
    ).approvals.handlers;
    const handler = handlers.get(OFFICIAL_PUBLISH_APPROVAL_ACTION)!;
    expect(handler.code).toBe('P-13');
    await handler.run(POL, POLA, { toolsetId: ID, contentHash: HASH, body: BODY }, 'req-3');
    expect(official.publish).toHaveBeenCalledWith('tx-manager', ID, {
      changelog: undefined,
      expectedHash: HASH,
    });
  });

  it('moves no epoch and sends no notice when the override log entry fails', async () => {
    const { service, official } = build({ overrideFails: true });
    await expect(service.publish(POL, ID, BODY, null, POLA, HASH)).rejects.toThrow(
      'override log entry failed',
    );
    expect(official.afterPublish).not.toHaveBeenCalled();
  });
});

describe('OperatorOfficialToolsetsService — drafts', () => {
  it('freezes the Draft while a publish waits for its second operator', async () => {
    const { service, official } = build({ pending: true });
    expect(await errorOf(() => service.update(POL, ID, { name: 'New' }))).toEqual({
      code: ToolsetErrorCode.TOOLSET_STATE,
      status: 409,
    });
    expect(official.updateDraft).not.toHaveBeenCalled();
  });

  it('edits the Draft in a transaction, then lets the live views re-read', async () => {
    const { service, official } = build();
    await service.update(POL, ID, { tags: ['weather'] });
    expect(official.updateDraft).toHaveBeenCalledWith('tx-manager', ID, { tags: ['weather'] });
    expect(official.afterDraftChange).toHaveBeenCalledWith({ liveChanged: false });
  });

  it('shows a waiting publish on the set', async () => {
    const { service } = build({ pending: true });
    expect((await service.get(ID)).pendingPublish).toMatchObject({
      approvalId: 'approval-1',
      requestedBy: POL.operatorId,
    });
    expect((await build().service.list()).toolsets[0].pendingPublish).toBeNull();
  });
});

describe('register rows for official tool sets (owner decision 4, 2026-10-26)', () => {
  const rolesOf = (controller: { prototype: object }, method: string): OperatorRole[] =>
    Reflect.getMetadata(
      REQUIRE_ROLES_METADATA,
      (controller.prototype as Record<string, unknown>)[method] as object,
    );

  it('P-13: POL/POLA publish, two-person, a POLA approves', () => {
    expect(OVERRIDE_REGISTER['P-13']).toMatchObject({
      roles: [OperatorRole.POL, OperatorRole.POLA],
      approval: ApprovalMode.TWO_PERSON,
      approverRoles: [OperatorRole.POLA],
      reversible: true,
      implemented: true,
    });
    expect(rolesOf(OperatorOfficialToolsetsController, 'publish')).toEqual([
      OperatorRole.POL,
      OperatorRole.POLA,
    ]);
  });

  it('A-15 delist and A-20 relist admit POL/POLA in the register and on the route', () => {
    for (const [code, method] of [
      ['A-15', 'delist'],
      ['A-20', 'relist'],
    ] as const) {
      expect(OVERRIDE_REGISTER[code].roles).toEqual(
        expect.arrayContaining([OperatorRole.POL, OperatorRole.POLA]),
      );
      expect(rolesOf(OperatorModerationController, method)).toEqual(
        expect.arrayContaining([...OVERRIDE_REGISTER[code].roles]),
      );
    }
  });

  it('A-18, the second operator’s confirmation within 72 h, is unchanged', () => {
    expect(OVERRIDE_REGISTER['A-18'].roles).toEqual([OperatorRole.ADJ, OperatorRole.ADJL]);
    expect(rolesOf(OperatorModerationController, 'confirm')).not.toContain(OperatorRole.POL);
  });
});
