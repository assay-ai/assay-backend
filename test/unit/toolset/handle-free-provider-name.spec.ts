import { DEPOSIT_MINIMUM_USD } from '@modules/payment/constants/deposit-intent.constants';
import { HandleStatus } from '@modules/toolset/domain/handle';
import { ToolsetErrorCode, ToolsetErrors } from '@modules/toolset/errors/toolset.errors';
import { HandlesService } from '@modules/toolset/services/handles.service';

/**
 * A set-up provider (ACTIVE provider + proved payout address) may claim its
 * first public name without funding; every other name, and every other
 * unfunded organization, keeps the fund-once rule.
 */
describe('the free first public name of a set-up provider', () => {
  const actor = { type: 'user' as const, id: 'login' };
  const session = { organizationId: 'org-1', agentId: 'agent-1' } as never;

  interface World {
    funded: boolean;
    providerSetUp: boolean;
    /** The organization row: what `findById` and the locked re-read return. */
    org: { id: string; handle: string | null; handleStatus: string | null };
    /** `org_handle_claims` rows of org-1, never deleted. */
    claims: number;
  }

  function harness(initial: Partial<World> = {}) {
    const world: World = {
      funded: false,
      providerSetUp: true,
      org: { id: 'org-1', handle: null, handleStatus: null },
      claims: 0,
      ...initial,
    };
    const freeNameReads: string[] = [];
    const freeNameAnswer = (where: string) => {
      freeNameReads.push(where);
      return [
        {
          providerSetUp: world.providerSetUp,
          claimedBefore: world.org.handle !== null || world.claims > 0,
        },
      ];
    };
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (/"providerSetUp"/.test(sql)) return freeNameAnswer('locked');
        if (/AS current/.test(sql)) return [{ current: false, held: false }];
        return [];
      }),
      findOne: jest.fn(async () => ({ ...world.org })),
      update: jest.fn(async (_entity: unknown, _where: unknown, patch: Record<string, unknown>) => {
        world.org = { ...world.org, ...(patch as Partial<World['org']>) };
        return { affected: 1 };
      }),
      insert: jest.fn(async () => {
        world.claims += 1;
        return {};
      }),
    };
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        if (/AS verified/.test(sql)) return [{ verified: world.funded }];
        return [];
      }),
      transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) => work(manager)),
      manager: {
        query: jest.fn(async (sql: string) =>
          /"providerSetUp"/.test(sql) ? freeNameAnswer('read') : [],
        ),
      },
    };
    const audit = { record: jest.fn(async () => undefined) };
    const handles = new HandlesService(
      { findById: jest.fn(async () => ({ ...world.org })) } as never,
      { findById: jest.fn(async () => ({ privyUserId: 'privy:1' })) } as never,
      {} as never,
      { recentOrgIds: jest.fn(async () => []) } as never,
      audit as never,
      dataSource as never,
    );
    return { world, handles, manager, audit, freeNameReads };
  }

  const refusalOf = (work: Promise<unknown>) =>
    work.then(
      () => null,
      (error: { errorCode?: string; statusCode?: number; publicContext?: unknown }) => ({
        code: error.errorCode,
        status: error.statusCode,
        context: error.publicContext,
      }),
    );

  it('lets a set-up provider claim its first name without a deposit', async () => {
    const { world, handles, manager, audit, freeNameReads } = harness();

    await expect(handles.claim(session, 'acme', actor)).resolves.toMatchObject({
      handle: 'acme',
    });

    expect(world.org).toMatchObject({ handle: 'acme', handleStatus: HandleStatus.ACTIVE });
    expect(manager.insert).toHaveBeenCalledTimes(1);
    // Checked before the transaction and again under the organization's lock.
    expect(freeNameReads).toEqual(['read', 'locked']);
    expect(audit.record).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ after: { handle: 'acme', freeProviderName: true } }),
    );
  });

  it('refuses a second name (a change before the lock) unless funded', async () => {
    const { handles, manager } = harness();
    await handles.claim(session, 'acme', actor);
    manager.update.mockClear();

    expect(await refusalOf(handles.claim(session, 'acme-two', actor))).toEqual({
      code: ToolsetErrorCode.TOOLSET_HANDLE_CLAIM_REFUSED,
      status: 403,
      context: {
        reason: 'NOT_VERIFIED',
        fundingRequired: true,
        minimumDepositUsd: DEPOSIT_MINIMUM_USD,
        providerSetUp: true,
      },
    });
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('lets a funded set-up provider change its name as before', async () => {
    const { world, handles } = harness();
    await handles.claim(session, 'acme', actor);
    world.funded = true;

    await expect(handles.claim(session, 'acme-two', actor)).resolves.toMatchObject({
      handle: 'acme-two',
    });
  });

  it('cannot be replayed after the handle was cleared (takedown, reassignment)', async () => {
    const { world, handles } = harness();
    await handles.claim(session, 'acme', actor);
    world.org = { id: 'org-1', handle: null, handleStatus: null };

    expect(await refusalOf(handles.claim(session, 'acme-again', actor))).toMatchObject({
      code: ToolsetErrorCode.TOOLSET_HANDLE_CLAIM_REFUSED,
      context: { reason: 'NOT_VERIFIED', providerSetUp: true },
    });
  });

  it('refuses the loser of two concurrent first claims under the lock', async () => {
    // Both passed the read before the transaction; the other one committed first.
    const { world, handles, manager } = harness();
    manager.findOne.mockImplementationOnce(async () => {
      world.org = { id: 'org-1', handle: 'other', handleStatus: HandleStatus.ACTIVE };
      world.claims += 1;
      return { ...world.org };
    });

    expect(await refusalOf(handles.claim(session, 'acme', actor))).toMatchObject({
      code: ToolsetErrorCode.TOOLSET_HANDLE_CLAIM_REFUSED,
      context: { reason: 'NOT_VERIFIED' },
    });
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('refuses an organization that is not a set-up provider unless funded', async () => {
    const { handles, manager } = harness({ providerSetUp: false });

    expect(await refusalOf(handles.claim(session, 'newco', actor))).toEqual({
      code: ToolsetErrorCode.TOOLSET_HANDLE_CLAIM_REFUSED,
      status: 403,
      context: {
        reason: 'NOT_VERIFIED',
        fundingRequired: true,
        minimumDepositUsd: DEPOSIT_MINIMUM_USD,
        providerSetUp: false,
      },
    });
    expect(manager.findOne).not.toHaveBeenCalled();
  });

  it('leaves a funded organization unchanged: no provider check, plain audit', async () => {
    const { handles, audit, freeNameReads, manager } = harness({
      funded: true,
      providerSetUp: false,
    });

    await expect(handles.claim(session, 'buyerco', actor)).resolves.toMatchObject({
      handle: 'buyerco',
    });
    await expect(handles.claim(session, 'buyerco-2', actor)).resolves.toMatchObject({
      handle: 'buyerco-2',
    });
    expect(freeNameReads).toEqual([]);
    expect(audit.record).toHaveBeenLastCalledWith(
      manager,
      expect.objectContaining({ after: { handle: 'buyerco-2' } }),
    );
  });

  it('says what to do next in the refusal message', () => {
    expect(
      ToolsetErrors.handleClaimRefused({
        reason: 'NOT_VERIFIED',
        minimumDepositUsd: 5,
        providerSetUp: false,
      }).message,
    ).toBe(
      'Add at least $5 in funds once, or finish provider setup, before choosing a public name',
    );
    expect(
      ToolsetErrors.handleClaimRefused({
        reason: 'NOT_VERIFIED',
        minimumDepositUsd: 5,
        providerSetUp: true,
      }).message,
    ).toBe('Your free public name is used; add at least $5 in funds once to choose another');
  });
});
