import { DataSource } from 'typeorm';

import { SpendPolicyRepository } from '@database/postgres/repositories/spend-policy.repository';
import { SpendPolicyDto, SpendPolicyScope } from '@modules/spend-policy/dto/get-spend-policy.dto';
import { SpendPolicyErrorCode } from '@modules/spend-policy/errors/spend-policy.errors';
import { SpendPolicyService } from '@modules/spend-policy/services/spend-policy.service';
import { AuditActor, AuditLogWriter } from '@shared/audit';
import { BaseError } from '@shared/errors/base.error';
import { SortDirection } from '@shared/api';

const ORG = 'org-11111111-1111-4111-8111-111111111111';
const AGENT = 'agent-11111111-1111-4111-8111-111111111111';
const USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DECIMALS = 6;
const ACTOR: AuditActor = { type: 'user', id: 'login-1' };

function policyRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'policy-1',
    organizationId: ORG,
    agentId: AGENT,
    policyVersion: 3,
    assetId: USDC,
    decimals: DECIMALS,
    perCallMax: '500000',
    dailyCap: '10000000',
    monthlyCap: '100000000',
    maxCallsPerHour: 60,
    requireApprovalAbove: '2000000',
    paused: false,
    changedBy: 'operator@example.com',
    changeReason: null,
    supersededAt: null,
    createdAt: new Date('2026-08-07T09:14:00.000Z'),
    updatedAt: new Date('2026-08-07T09:14:00.000Z'),
    ...overrides,
  };
}

/** A `manager.createQueryBuilder()` fake that supports the two chains `writeVersion` builds. */
function fakeManager(options: {
  updateAffected?: number;
  insertedId?: string;
  findOneByOrFailResult?: Record<string, unknown>;
}) {
  const updateWheres: Array<{ sql: string; params: unknown }> = [];
  let updateSet: unknown;
  let insertValues: unknown;

  const updateBuilder: any = {
    set(v: unknown) {
      updateSet = v;
      return updateBuilder;
    },
    where(sql: string, params: unknown) {
      updateWheres.push({ sql, params });
      return updateBuilder;
    },
    andWhere(sql: string, params: unknown) {
      updateWheres.push({ sql, params });
      return updateBuilder;
    },
    async execute() {
      return { affected: options.updateAffected ?? 1 };
    },
  };

  const insertBuilder: any = {
    into() {
      return insertBuilder;
    },
    values(v: unknown) {
      insertValues = v;
      return insertBuilder;
    },
    async execute() {
      return { identifiers: [{ id: options.insertedId ?? 'policy-new' }] };
    },
  };

  const manager = {
    createQueryBuilder() {
      return {
        update: () => updateBuilder,
        insert: () => insertBuilder,
      };
    },
    async findOneByOrFail(_entity: unknown, criteria: Record<string, unknown>) {
      return options.findOneByOrFailResult ?? policyRow({ ...criteria, policyVersion: 1 });
    },
  };

  return {
    manager,
    updateWheres,
    get updateSet() {
      return updateSet;
    },
    get insertValues() {
      return insertValues as Record<string, unknown> | undefined;
    },
  };
}

function build(options: {
  findOneResults?: Array<Record<string, unknown> | null>;
  findLive?: jest.Mock;
  existsBy?: jest.Mock;
  transactionOptions?: Parameters<typeof fakeManager>[0];
}) {
  const findOneQueue = [...(options.findOneResults ?? [])];

  const policies = {
    findOne: jest.fn().mockImplementation(async () => findOneQueue.shift() ?? null),
    findLive: options.findLive ?? jest.fn().mockResolvedValue(null),
    existsBy: options.existsBy ?? jest.fn().mockResolvedValue(false),
    createQueryBuilder: jest.fn(),
  } as unknown as SpendPolicyRepository;

  const tx = fakeManager(options.transactionOptions ?? {});
  const dataSource = {
    transaction: jest
      .fn()
      .mockImplementation(async (work: (manager: unknown) => unknown) => work(tx.manager)),
  } as unknown as DataSource;

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new SpendPolicyService(policies, dataSource, audit as unknown as AuditLogWriter);
  return { service, policies, dataSource, tx, audit };
}

function errorCodeOf(fn: () => Promise<unknown>): Promise<string> {
  return fn()
    .then(() => {
      throw new Error('expected a throw, got none');
    })
    .catch((error) => (error as BaseError).errorCode);
}

describe('SpendPolicyService.get', () => {
  it('returns the live policy, scoped AGENT when agentId is set', async () => {
    const findLive = jest.fn().mockResolvedValue(policyRow());
    const { service } = build({ findLive });

    const dto: SpendPolicyDto = await service.get(ORG, AGENT);

    expect(findLive).toHaveBeenCalledWith(ORG, AGENT);
    expect(dto.scope).toBe(SpendPolicyScope.AGENT);
    expect(dto.perCallMax).toEqual({ amount: '500000', asset: USDC, decimals: DECIMALS });
    expect(dto.policyVersion).toBe(3);
  });

  it('scopes ORGANIZATION when the live row has no agentId (the org default answered it)', async () => {
    const findLive = jest.fn().mockResolvedValue(policyRow({ agentId: null }));
    const { service } = build({ findLive });

    const dto = await service.get(ORG, AGENT);

    expect(dto.scope).toBe(SpendPolicyScope.ORGANIZATION);
    expect(dto.agentId).toBeNull();
  });

  it('renders a null cap as null, not zero', async () => {
    const findLive = jest.fn().mockResolvedValue(policyRow({ dailyCap: null }));
    const { service } = build({ findLive });

    const dto = await service.get(ORG, AGENT);

    expect(dto.dailyCap).toBeNull();
  });

  it('throws SPEND_POLICY_NOT_FOUND when neither the agent nor the organization has one', async () => {
    const { service } = build({ findLive: jest.fn().mockResolvedValue(null) });

    const code = await errorCodeOf(() => service.get(ORG, AGENT));

    expect(code).toBe(SpendPolicyErrorCode.SPEND_POLICY_NOT_FOUND);
  });
});

describe('SpendPolicyService.patch', () => {
  it('requires assetId/decimals when bootstrapping with no current row and no org default', async () => {
    const { service } = build({ findOneResults: [null, null] });

    const code = await errorCodeOf(() => service.patch(ORG, AGENT, {}, ACTOR));

    expect(code).toBe(SpendPolicyErrorCode.SPEND_POLICY_ASSET_REQUIRED);
  });

  it('bootstraps version 1 at the agent scope when the caller supplies assetId/decimals', async () => {
    const { service, tx } = build({ findOneResults: [null, null] });

    await service.patch(
      ORG,
      AGENT,
      { assetId: USDC, decimals: DECIMALS, dailyCap: '1000000' },
      ACTOR,
    );

    expect(tx.insertValues).toMatchObject({
      organizationId: ORG,
      agentId: AGENT,
      policyVersion: 1,
      assetId: USDC,
      decimals: DECIMALS,
      dailyCap: '1000000',
      perCallMax: null,
      paused: false,
      changedBy: `agent:${AGENT}`,
      supersededAt: null,
    });
  });

  it('inherits assetId/decimals from the organization default when there is no agent override yet', async () => {
    const orgDefault = policyRow({
      agentId: null,
      assetId: USDC,
      decimals: DECIMALS,
      policyVersion: 9,
    });
    const { service, tx } = build({ findOneResults: [null, orgDefault] });

    await service.patch(ORG, AGENT, { perCallMax: '250000' }, ACTOR);

    expect(tx.insertValues).toMatchObject({
      assetId: USDC,
      decimals: DECIMALS,
      // Version numbering is per scope — a brand-new agent override starts at
      // 1, it does not continue the organization default's sequence.
      policyVersion: 1,
      perCallMax: '250000',
    });
  });

  it("keeps the organization default's caps on an agent's first override that omits them", async () => {
    // The console's Pause/Resume sends `{ paused }` and nothing else. Inheriting
    // only the asset here wrote an agent row with every cap null — uncapped.
    const orgDefault = policyRow({
      agentId: null,
      assetId: USDC,
      decimals: DECIMALS,
      perCallMax: '500000',
      dailyCap: '10000000',
      monthlyCap: '100000000',
      maxSpendPerHour: '5000000',
      maxCallsPerMinute: 60,
      requireApprovalAbove: '2000000',
    });
    const { service, tx } = build({ findOneResults: [null, orgDefault] });

    await service.patch(ORG, AGENT, { paused: true }, ACTOR);

    expect(tx.insertValues).toMatchObject({
      policyVersion: 1,
      paused: true,
      perCallMax: '500000',
      dailyCap: '10000000',
      monthlyCap: '100000000',
      maxSpendPerHour: '5000000',
      maxCallsPerMinute: 60,
      requireApprovalAbove: '2000000',
    });
  });

  it('still clears an inherited cap when the first override names it null', async () => {
    const orgDefault = policyRow({
      agentId: null,
      assetId: USDC,
      decimals: DECIMALS,
      dailyCap: '10000000',
    });
    const { service, tx } = build({ findOneResults: [null, orgDefault] });

    await service.patch(ORG, AGENT, { dailyCap: null }, ACTOR);

    expect(tx.insertValues).toMatchObject({ dailyCap: null });
  });

  it('supersedes the existing agent-scoped row and increments its version', async () => {
    const current = policyRow({ policyVersion: 3, dailyCap: '10000000' });
    const { service, tx } = build({ findOneResults: [current] });

    await service.patch(ORG, AGENT, { changeReason: 'raised for the weekend' }, ACTOR);

    expect(tx.updateWheres.some((w) => String(w.sql).includes('superseded_at IS NULL'))).toBe(true);
    expect(tx.updateWheres.some((w) => JSON.stringify(w.params).includes(current.id))).toBe(true);
    expect(tx.insertValues).toMatchObject({
      policyVersion: 4,
      dailyCap: '10000000', // omitted in the patch — carried over from `current`
      changeReason: 'raised for the weekend',
    });
  });

  it('an omitted field keeps the previous value; an explicit null clears it', async () => {
    const current = policyRow({ perCallMax: '500000', requireApprovalAbove: '2000000' });
    const { service, tx } = build({ findOneResults: [current] });

    await service.patch(ORG, AGENT, { requireApprovalAbove: null }, ACTOR);

    expect(tx.insertValues).toMatchObject({
      perCallMax: '500000', // omitted -> kept
      requireApprovalAbove: null, // explicit null -> cleared
    });
  });

  it('records the session agent as changedBy', async () => {
    const { service, tx } = build({ findOneResults: [null, null] });

    await service.patch(ORG, AGENT, { assetId: USDC, decimals: DECIMALS }, ACTOR);

    expect(tx.insertValues?.changedBy).toBe(`agent:${AGENT}`);
  });

  it('raises SPEND_POLICY_CONCURRENT_MODIFICATION when the supersede loses the race', async () => {
    const current = policyRow();
    const { service } = build({
      findOneResults: [current],
      transactionOptions: { updateAffected: 0 },
    });

    const code = await errorCodeOf(() => service.patch(ORG, AGENT, { paused: true }, ACTOR));

    expect(code).toBe(SpendPolicyErrorCode.SPEND_POLICY_CONCURRENT_MODIFICATION);
  });
});

describe('SpendPolicyService.patch — audit log (BUG-R2-B4-01)', () => {
  it('records spend_policy.created for the first version at the agent scope', async () => {
    const { service, tx, audit } = build({ findOneResults: [null, null] });

    await service.patch(
      ORG,
      AGENT,
      { assetId: USDC, decimals: DECIMALS, dailyCap: '1000000' },
      ACTOR,
    );

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(tx.manager, {
      organizationId: ORG,
      actor: ACTOR,
      action: 'spend_policy.created',
      resourceType: 'spend_policy',
      resourceId: 'policy-new',
      before: null,
      after: { dailyCap: '1000000', paused: false, policyVersion: 1 },
    });
  });

  it('records spend_policy.updated with only the changed fields, before and after', async () => {
    const current = policyRow({ policyVersion: 3, dailyCap: '10000000', paused: false });
    const { service, tx, audit } = build({ findOneResults: [current] });

    await service.patch(ORG, AGENT, { dailyCap: '20000000', changeReason: 'weekend' }, ACTOR);

    expect(audit.record).toHaveBeenCalledWith(tx.manager, {
      organizationId: ORG,
      actor: ACTOR,
      action: 'spend_policy.updated',
      resourceType: 'spend_policy',
      resourceId: 'policy-new',
      before: { dailyCap: '10000000', policyVersion: 3 },
      after: { dailyCap: '20000000', policyVersion: 4, changeReason: 'weekend' },
    });
  });

  it.each([
    [true, false],
    [false, true],
  ])('records a pause toggle to %s as spend_policy.updated', async (paused, was) => {
    const current = policyRow({ policyVersion: 3, paused: was });
    const { service, audit } = build({ findOneResults: [current] });

    await service.patch(ORG, AGENT, { paused }, ACTOR);

    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'spend_policy.updated',
      before: { paused: was, policyVersion: 3 },
      after: { paused, policyVersion: 4 },
    });
  });

  it('writes the entry in the same transaction as the version', async () => {
    const { service, dataSource, tx, audit } = build({ findOneResults: [policyRow()] });

    await service.patch(ORG, AGENT, { paused: true }, ACTOR);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toBe(tx.manager);
  });

  it('fails the write when the audit entry cannot be recorded', async () => {
    const { service, audit } = build({ findOneResults: [policyRow()] });
    audit.record.mockRejectedValue(new Error('audit down'));

    await expect(service.patch(ORG, AGENT, { paused: true }, ACTOR)).rejects.toThrow('audit down');
  });

  it('records nothing when the supersede loses the race', async () => {
    const { service, audit } = build({
      findOneResults: [policyRow()],
      transactionOptions: { updateAffected: 0 },
    });

    await errorCodeOf(() => service.patch(ORG, AGENT, { paused: true }, ACTOR));

    expect(audit.record).not.toHaveBeenCalled();
  });
});

/**
 * BUG-R8-A-01: a PATCH whose values equal the live policy used to supersede it
 * with an identical version and write an audit entry whose only "change" was
 * `policyVersion 18 → 19`.
 */
describe('SpendPolicyService.patch — a request that changes nothing (BUG-R8-A-01)', () => {
  const current = () =>
    policyRow({ policyVersion: 18, dailyCap: '10000000', pinnedTools: ['search'], paused: false });

  it.each([
    ['the same value for one field', { dailyCap: '10000000' }],
    ['an empty body', {}],
    ['every field restated', { perCallMax: '500000', dailyCap: '10000000', paused: false }],
    ['null for a limit that is already unset', { maxSpendPerHour: null }],
    ['the same asset', { assetId: USDC, decimals: DECIMALS }],
  ])('writes no version and no audit entry for %s', async (_name, patch) => {
    const row = current();
    const { service, dataSource, tx, audit } = build({ findOneResults: [row] });

    const result = await service.patch(ORG, AGENT, patch, ACTOR);

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(tx.insertValues).toBeUndefined();
    expect(audit.record).not.toHaveBeenCalled();
    // The caller is answered with the policy that is still live.
    expect(result).toMatchObject({ id: row.id, policyVersion: 18, changedBy: row.changedBy });
  });

  it.each([
    ['a different value', { dailyCap: '10000001' }],
    ['a cleared limit', { dailyCap: null }],
    ['a pause', { paused: true }],
    ['a reason, which is itself something to record', { changeReason: 'reviewed, unchanged' }],
  ])('still writes a version for %s', async (_name, patch) => {
    const { service, tx, audit } = build({ findOneResults: [current()] });

    await service.patch(ORG, AGENT, patch, ACTOR);

    expect(tx.insertValues).toMatchObject({ policyVersion: 19 });
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('still writes the first agent-scoped version when it restates the organization default', async () => {
    const orgDefault = policyRow({ agentId: null, policyVersion: 2, dailyCap: '10000000' });
    const { service, tx, audit } = build({ findOneResults: [null, orgDefault] });

    await service.patch(ORG, AGENT, { dailyCap: '10000000' }, ACTOR);

    expect(tx.insertValues).toMatchObject({ agentId: AGENT, policyVersion: 1 });
    expect(audit.record.mock.calls[0][1]).toMatchObject({ action: 'spend_policy.created' });
  });
});

describe('SpendPolicyService.history', () => {
  function query() {
    return { limit: 25, order: SortDirection.DESC } as any;
  }

  it('scopes to the agent when the agent has ever had its own row', async () => {
    const existsBy = jest.fn().mockResolvedValue(true);
    const wheres: Array<{ sql: string; params: unknown }> = [];
    const qb: any = {
      where(sql: string, params: unknown) {
        wheres.push({ sql, params });
        return qb;
      },
      andWhere(sql: string, params: unknown) {
        wheres.push({ sql, params });
        return qb;
      },
      orderBy() {
        return qb;
      },
      addOrderBy() {
        return qb;
      },
      take() {
        return qb;
      },
      limit() {
        return qb;
      },
      async getMany() {
        return [policyRow()];
      },
      addSelect() {
        return qb;
      },
      async getRawAndEntities() {
        return { entities: [policyRow()], raw: [] };
      },
    };
    const { service, policies } = build({ existsBy });
    (policies.createQueryBuilder as jest.Mock).mockReturnValue(qb);

    await service.history(ORG, AGENT, query());

    expect(existsBy).toHaveBeenCalledWith({ organizationId: ORG, agentId: AGENT });
    expect(wheres.some((w) => w.sql.includes('policy.agentId = :agentId'))).toBe(true);
  });

  it('falls back to the organization default chain when the agent never had its own row', async () => {
    const existsBy = jest.fn().mockResolvedValue(false);
    const wheres: Array<{ sql: string; params: unknown }> = [];
    const qb: any = {
      where(sql: string, params: unknown) {
        wheres.push({ sql, params });
        return qb;
      },
      andWhere(sql: string, params: unknown) {
        wheres.push({ sql, params });
        return qb;
      },
      orderBy() {
        return qb;
      },
      addOrderBy() {
        return qb;
      },
      take() {
        return qb;
      },
      limit() {
        return qb;
      },
      async getMany() {
        return [policyRow({ agentId: null })];
      },
      addSelect() {
        return qb;
      },
      async getRawAndEntities() {
        return { entities: [policyRow({ agentId: null })], raw: [] };
      },
    };
    const { service, policies } = build({ existsBy });
    (policies.createQueryBuilder as jest.Mock).mockReturnValue(qb);

    const page = await service.history(ORG, AGENT, query());

    expect(wheres.some((w) => w.sql.includes('policy.agentId IS NULL'))).toBe(true);
    expect(page.items[0].scope).toBe(SpendPolicyScope.ORGANIZATION);
  });
});
