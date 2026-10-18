import { OperatorRole } from '@modules/operator/domain/override-register';
import { OperatorErrors } from '@modules/operator/errors/operator.errors';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OperatorApprovalService } from '@modules/operator/services/operator-approval.service';
import {
  LIFT_CUTOFF_APPROVAL_ACTION,
  OperatorModerationService,
  RENAME_HANDLE_APPROVAL_ACTION,
} from '@modules/operator/services/operator-moderation.service';
import { CutoffAction } from '@modules/toolset/services/toolset-moderation.service';

const OPERATOR: OperatorSession = {
  operatorId: 'op-1',
  subject: 'one@',
  displayName: 'One',
  email: 'one@example.com',
  roles: [OperatorRole.ADJL],
  authorityLimitMinor: null,
};
const BODY = { reasonCode: 'ABUSE', note: 'impersonates another organization' };

/** Which register row each moderation action cites, and which ones wait for a second person. */
describe('OperatorModerationService', () => {
  function build(
    cutoff: Record<string, unknown> = {
      id: 'c1',
      confirmedAt: null,
      targetType: 'TOOLSET',
      targetId: 't1',
    },
  ) {
    const performed: { code: string; escalate?: boolean; organizationId: string | null }[] = [];
    const overrides = {
      perform: jest.fn(
        async (
          context: Record<string, unknown>,
          mutation: (runner: unknown) => Promise<{ value: unknown }>,
        ) => {
          // The register refuses a two-person occurrence without an approver.
          if (
            (context.code === 'A-21' || context.code === 'A-22' || context.escalateToTwoPerson) &&
            !context.approver
          ) {
            throw OperatorErrors.secondApproverRequired({ code: context.code });
          }
          performed.push({
            code: context.code as string,
            escalate: context.escalateToTwoPerson as boolean | undefined,
            organizationId: context.organizationId as string | null,
          });
          return (await mutation({ manager: {} })).value;
        },
      ),
    };
    const queued: string[] = [];
    const approvals = {
      register: jest.fn(),
      orQueue: jest.fn(async (request: { action: string }, attempt: () => Promise<unknown>) => {
        try {
          return await attempt();
        } catch {
          queued.push(request.action);
          return { approvalId: 'a1', status: 'PENDING' };
        }
      }),
    } as unknown as OperatorApprovalService;
    const row = {
      id: 'c1',
      targetType: 'TOOLSET',
      targetId: 't1',
      action: 'TAKEDOWN',
      actedBy: 'op-1',
      actedAt: new Date(),
      confirmBy: new Date(),
      confirmedBy: null,
      confirmedAt: null,
      revertedAt: null,
      revertReason: null,
      reportId: null,
      note: 'n',
    };
    const moderation = {
      cutoffToolset: jest.fn(async () => ({ cutoff: row })),
      cutoffHandle: jest.fn(async () => ({ cutoff: row, organizationId: 'org-1' })),
      confirm: jest.fn(async () => row),
      revert: jest.fn(async () => row),
      renameHandle: jest.fn(async () => ({ organizationId: 'org-1', aliasUntil: new Date() })),
      reassignHandle: jest.fn(async () => ({ fromOrganizationId: 'org-1' })),
      resolveReport: jest.fn(),
      relist: jest.fn(),
      afterCommit: jest.fn(async () => undefined),
    };
    const service = new OperatorModerationService(
      overrides as never,
      approvals,
      moderation as never,
      {
        findAnyById: async () => ({ id: 't1', ownerOrgId: 'org-1', visibility: 'PUBLIC' }),
      } as never,
      { findOneBy: async () => cutoff } as never,
      { findOneBy: async () => null } as never,
    );
    return { service, performed, queued, moderation, approvals };
  }

  it('registers its three two-person actions with the approvals queue', () => {
    const { approvals } = build();
    const actions = (approvals.register as jest.Mock).mock.calls.map(([action]) => action);
    expect(actions).toEqual(['handle.rename', 'handle.reassign', 'moderation.cutoff_lift']);
  });

  it('delists and takes down at once under A-15 and A-16, naming the owner, and invalidates caches', async () => {
    const { service, performed, moderation } = build();
    await service.cutoffToolset(OPERATOR, 't1', CutoffAction.DELIST, BODY, null);
    await service.cutoffToolset(OPERATOR, 't1', CutoffAction.TAKEDOWN, BODY, null);
    expect(performed).toEqual([
      { code: 'A-15', escalate: undefined, organizationId: 'org-1' },
      { code: 'A-16', escalate: undefined, organizationId: 'org-1' },
    ]);
    expect(moderation.afterCommit).toHaveBeenCalledWith(['org-1']);
  });

  it('takes a handle down under A-17 and confirms under A-18', async () => {
    const { service, performed } = build();
    await service.takedownHandle(OPERATOR, 'acme', BODY, null);
    await service.confirmCutoff(OPERATOR, 'c1', BODY, null);
    expect(performed.map((p) => p.code)).toEqual(['A-17', 'A-18']);
  });

  it('queues a rename for a second operator, and runs it with one', async () => {
    const { service, queued, moderation } = build();
    const result = await service.renameHandle(
      OPERATOR,
      'acme',
      { ...BODY, newHandle: 'acme-labs' },
      null,
    );
    expect(result).toMatchObject({ status: 'PENDING' });
    expect(queued).toEqual([RENAME_HANDLE_APPROVAL_ACTION]);
    expect(moderation.renameHandle).not.toHaveBeenCalled();
    await service.renameHandle(OPERATOR, 'acme', { ...BODY, newHandle: 'acme-labs' }, null, {
      ...OPERATOR,
      operatorId: 'op-2',
      approvalId: 'a1',
    });
    expect(moderation.renameHandle).toHaveBeenCalled();
  });

  it('rejects a pending cutoff with one operator, but lifting a confirmed one waits for two', async () => {
    const pending = build();
    await pending.service.revertCutoff(OPERATOR, 'c1', BODY, null);
    expect(pending.performed).toEqual([{ code: 'A-19', escalate: false, organizationId: null }]);

    const confirmed = build({
      id: 'c1',
      confirmedAt: new Date(),
      targetType: 'TOOLSET',
      targetId: 't1',
    });
    const result = await confirmed.service.revertCutoff(OPERATOR, 'c1', BODY, null);
    expect(result).toMatchObject({ status: 'PENDING' });
    expect(confirmed.queued).toEqual([LIFT_CUTOFF_APPROVAL_ACTION]);
    expect(confirmed.moderation.revert).not.toHaveBeenCalled();
  });

  it('lists cutoffs with each target’s name, filtered by targetType', async () => {
    const at = new Date('2026-10-01T00:00:00Z');
    const rows = [
      { id: 'c1', targetType: 'TOOL', targetId: 'tool-1' },
      { id: 'c2', targetType: 'TOOLSET', targetId: 'set-1' },
      { id: 'c3', targetType: 'HANDLE', targetId: 'acme' },
      { id: 'c4', targetType: 'TOOL', targetId: 'tool-gone' },
    ].map((row) => ({
      ...row,
      action: 'TAKEDOWN',
      actedBy: 'op-1',
      actedAt: at,
      confirmBy: at,
      confirmedBy: null,
      confirmedAt: null,
      revertedAt: null,
      revertReason: null,
      reportId: null,
      note: 'n',
    }));
    const find = jest.fn(async () => rows);
    const managerFind = jest.fn(async (entity: { name: string }) =>
      entity.name === 'ToolEntity'
        ? [{ id: 'tool-1', name: 'acme__search_posts' }]
        : [{ id: 'set-1', name: 'Acme kit' }],
    );
    const service = new OperatorModerationService(
      { perform: jest.fn() } as never,
      { register: jest.fn() } as never,
      {} as never,
      {} as never,
      { find, manager: { find: managerFind } } as never,
      {} as never,
    );
    const listed = await service.listCutoffs({ pending: true, targetType: 'TOOL' });
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ targetType: 'TOOL' }),
      }),
    );
    expect(listed.map((row) => [row.id, row.targetName])).toEqual([
      ['c1', 'acme__search_posts'],
      ['c2', 'Acme kit'],
      ['c3', 'acme'],
      ['c4', null],
    ]);
  });

  it('tells the provider about its tool’s takedown, and about the takedown lifted', async () => {
    const { service, moderation } = build({
      id: 'c1',
      confirmedAt: null,
      targetType: 'TOOL',
      targetId: 'tool-1',
    });
    const announced: unknown[] = [];
    Object.assign(moderation, {
      cutoffTool: jest.fn(async () => ({
        cutoff: { id: 'c1', actedAt: new Date(), confirmBy: new Date() },
        organizationId: 'org-1',
      })),
      announceTool: jest.fn(async (...args: unknown[]) => {
        announced.push(args);
      }),
    });
    (service as unknown as { cutoffs: { query: unknown } }).cutoffs.query = async () => [
      { ownerOrgId: 'org-1' },
    ];
    await service.takedownTool(OPERATOR, 'tool-1', BODY, null);
    await service.revertCutoff(OPERATOR, 'c1', BODY, null);
    expect(announced).toEqual([
      ['tool-1', 'TAKEN_DOWN'],
      ['tool-1', 'TAKEDOWN_LIFTED'],
    ]);
  });
});
