import { HandleStatus } from '@modules/toolset/domain/handle';
import { ToolsetErrorCode } from '@modules/toolset/errors/toolset.errors';
import { restoreTakenDownTool } from '@modules/toolset/services/handle-tools';
import { HandlesService } from '@modules/toolset/services/handles.service';

/** A manager that records every statement and answers the ones a test names. */
function fakeManager(answers: { match: RegExp; rows: unknown[] }[] = []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const manager = {
    statements,
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      return answers.find((answer) => answer.match.test(sql))?.rows ?? [];
    }),
    findOne: jest.fn(),
    update: jest.fn(async () => ({ affected: 1 })),
    insert: jest.fn(async () => ({})),
  };
  return manager;
}

describe('a lifted tool takedown locks like a handle takedown (review P3)', () => {
  it('locks the owner’s handle, then its row, before it touches the tool', async () => {
    const manager = fakeManager([
      { match: /SELECT owner_org_id/, rows: [{ ownerOrgId: 'org-1' }] },
      { match: /SELECT handle FROM organizations/, rows: [{ handle: 'acme' }] },
    ]);
    await restoreTakenDownTool(manager as never, 'tool-1');
    const order = manager.statements.map(({ sql, params }) => {
      if (/pg_advisory_xact_lock/.test(sql)) return `lock handle ${String(params[0])}`;
      if (/FROM organizations WHERE id = \$1 FOR UPDATE/.test(sql)) return 'lock org';
      if (/^\s*UPDATE tools/.test(sql)) return 'update tool';
      return 'read';
    });
    expect(order).toEqual(['read', 'read', 'lock handle acme', 'lock org', 'update tool']);
  });

  it('an owner with no handle is locked by its row alone', async () => {
    const manager = fakeManager([
      { match: /SELECT owner_org_id/, rows: [{ ownerOrgId: 'org-1' }] },
      { match: /SELECT handle FROM organizations/, rows: [{ handle: null }] },
    ]);
    await restoreTakenDownTool(manager as never, 'tool-1');
    expect(manager.statements.some(({ sql }) => /pg_advisory_xact_lock/.test(sql))).toBe(false);
    expect(manager.statements.some(({ sql }) => /FOR UPDATE/.test(sql))).toBe(true);
  });
});

describe('a claim reads the organization again under its locks (review P2)', () => {
  const session = { organizationId: 'org-1', agentId: 'agent-1' } as never;
  const actor = { type: 'user' as const, id: 'login' };

  function service(stale: Record<string, unknown>, manager: ReturnType<typeof fakeManager>) {
    const dataSource = {
      query: jest.fn(async (sql: string) => (/AS verified/.test(sql) ? [{ verified: true }] : [])),
      transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) => work(manager)),
      manager,
    };
    return new HandlesService(
      { findById: jest.fn(async () => stale) } as never,
      { findById: jest.fn(async () => ({ privyUserId: 'privy:1' })) } as never,
      {} as never,
      { recentOrgIds: jest.fn(async () => []) } as never,
      { record: jest.fn(async () => undefined) } as never,
      dataSource as never,
    );
  }

  const claimManager = () =>
    fakeManager([{ match: /AS current/, rows: [{ current: false, held: false }] }]);

  it('renames the tools under the handle it holds now, not the one read before', async () => {
    const manager = claimManager();
    manager.findOne.mockResolvedValue({ id: 'org-1', handle: 'newer', handleStatus: 'ACTIVE' });
    const handles = service({ id: 'org-1', handle: 'old', handleStatus: 'ACTIVE' }, manager);
    jest.spyOn(handles, 'get').mockResolvedValue({} as never);

    await handles.claim(session, 'fresh', actor);

    expect(manager.findOne.mock.calls[0][1]).toMatchObject({
      lock: { mode: 'pessimistic_write' },
    });
    const rename = manager.statements.find(({ sql }) => /SELECT id, name FROM tools/.test(sql));
    expect(rename?.params).toEqual(['org-1', 'newer__']);
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'org-1' },
      expect.objectContaining({ handle: 'fresh', handleStatus: HandleStatus.ACTIVE }),
    );
  });

  it('refuses when the handle was locked or frozen since the first read', async () => {
    const manager = claimManager();
    manager.findOne.mockResolvedValue({
      id: 'org-1',
      handle: 'old',
      handleStatus: HandleStatus.FROZEN,
    });
    const handles = service({ id: 'org-1', handle: 'old', handleStatus: 'ACTIVE' }, manager);

    await expect(handles.claim(session, 'fresh', actor)).rejects.toMatchObject({
      errorCode: ToolsetErrorCode.TOOLSET_HANDLE_LOCKED,
    });
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('changes nothing when a concurrent claim already took the same handle', async () => {
    const manager = claimManager();
    manager.findOne.mockResolvedValue({ id: 'org-1', handle: 'fresh', handleStatus: 'ACTIVE' });
    const handles = service({ id: 'org-1', handle: 'old', handleStatus: 'ACTIVE' }, manager);
    jest.spyOn(handles, 'get').mockResolvedValue({} as never);

    await handles.claim(session, 'fresh', actor);

    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });
});
