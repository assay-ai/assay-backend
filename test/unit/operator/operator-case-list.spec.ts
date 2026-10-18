import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { OperatorCasesController } from '@modules/operator/controllers/operator-cases.controller';
import { OperatorCaseStatus } from '@modules/operator/domain/operator-case-status';
import { ListOperatorCasesQueryDto } from '@modules/operator/dto/operator-case-list.dto';
import {
  OperatorCaseListService,
  decodeKey,
  encodeKey,
} from '@modules/operator/services/operator-case-list.service';
import { OperatorAuthGuard, OperatorRolesGuard } from '@shared/auth';
import { encodeCursor } from '@shared/api';

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const PROPOSAL = '22222222-2222-4222-8222-222222222222';
const ASSET = 'eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL,
    providerId: PROVIDER,
    bindingId: '33333333-3333-4333-8333-333333333333',
    toolId: 'geocode',
    penaltyAmount: '28470000',
    assetId: ASSET,
    decimals: 6,
    status: OperatorCaseStatus.CHAIN_DISPUTED,
    proposedAt: new Date('2026-09-21T08:09:00Z'),
    disputedAt: new Date('2026-09-23T10:00:00Z'),
    nextDeadline: new Date('2026-10-23T10:00:00Z'),
    k1: '2026-10-23T10:00:00.000000Z',
    k2: '-28470000',
    k3: '-1790237340',
    ...overrides,
  };
}

function build(rows: ReturnType<typeof row>[]) {
  const proposals = { findOperatorCasePage: jest.fn().mockResolvedValue(rows) };
  const providers = {
    // The `providers` row has its own id; the case names the organization.
    find: jest
      .fn()
      .mockResolvedValue([
        { id: 'a-provider-row-id', organizationId: PROVIDER, legalName: 'Northwind Geo' },
      ]),
  };
  const catalogue = {
    findTool: jest
      .fn()
      .mockImplementation(async (id: string) =>
        id === 'geocode'
          ? { id, name: 'Northwind geocode', endpoint: 'https://secret.example' }
          : null,
      ),
  };
  const service = new OperatorCaseListService(
    proposals as never,
    providers as never,
    catalogue as never,
  );
  return { service, proposals, providers, catalogue };
}

const query = (extra: Partial<ListOperatorCasesQueryDto> = {}) =>
  Object.assign(new ListOperatorCasesQueryDto(), extra);

describe('OperatorCaseListService', () => {
  it('returns exactly the allowlisted fields, and nothing of the binding but its tool name', async () => {
    const { service } = build([row()]);

    const page = await service.list(query());

    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0]).sort()).toEqual(
      [
        'amount',
        'chainId',
        'disputedAt',
        'nextDeadline',
        'proposalId',
        'proposedAt',
        'providerId',
        'providerName',
        'status',
        'toolName',
      ].sort(),
    );
    expect(Object.keys(page.items[0].amount).sort()).toEqual(['amount', 'asset', 'decimals']);
    expect(page.items[0]).toMatchObject({
      proposalId: PROPOSAL,
      providerName: 'Northwind Geo',
      toolName: 'Northwind geocode',
      chainId: 'eip155:84532',
      status: 'CHAIN_DISPUTED',
      amount: { amount: '28470000', asset: ASSET, decimals: 6 },
    });
    expect(JSON.stringify(page)).not.toContain('secret.example');
    expect(JSON.stringify(page)).not.toContain('bindingId');
  });

  it('asks for one row beyond the page, and hands out a cursor only when there is more', async () => {
    const { service, proposals } = build([
      row(),
      row({ id: '44444444-4444-4444-8444-444444444444' }),
    ]);

    const page = await service.list(query({ limit: 1 }));

    expect(proposals.findOperatorCasePage).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2, after: null }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.pageInfo.hasMore).toBe(true);
    expect(decodeKey(page.pageInfo.nextCursor as string)).toEqual({
      k1: '2026-10-23T10:00:00.000000Z',
      k2: '-28470000',
      k3: '-1790237340',
      id: PROPOSAL,
    });
  });

  it('ends the list with a null cursor', async () => {
    const { service } = build([row()]);

    const page = await service.list(query({ limit: 5 }));

    expect(page.pageInfo.nextCursor).toBeNull();
  });

  it('passes the filters and the decoded position through', async () => {
    const { service, proposals } = build([]);
    const cursor = encodeKey({ k1: 'infinity', k2: '0', k3: '-1.5', id: PROPOSAL });

    await service.list(
      query({
        status: [OperatorCaseStatus.CHAIN_DISPUTED, OperatorCaseStatus.CANCEL_REQUESTED],
        providerId: PROVIDER,
        cursor,
      }),
    );

    expect(proposals.findOperatorCasePage).toHaveBeenCalledWith({
      statuses: ['CHAIN_DISPUTED', 'CANCEL_REQUESTED'],
      providerId: PROVIDER,
      after: { k1: 'infinity', k2: '0', k3: '-1.5', id: PROPOSAL },
      limit: 26,
    });
  });

  it('falls back to ids when the provider or the tool is unknown, and to null with no binding', async () => {
    const other = '55555555-5555-4555-8555-555555555555';
    const { service } = build([
      row({ providerId: other, toolId: 'gone_tool' }),
      row({ id: '66666666-6666-4666-8666-666666666666', toolId: null }),
    ]);

    const page = await service.list(query());

    expect(page.items[0]).toMatchObject({ providerName: other, toolName: 'gone_tool' });
    expect(page.items[1].toolName).toBeNull();
  });

  it('reads provider names in one query, each key scoped to its own tenant', async () => {
    const { service, providers } = build([
      row(),
      row({ id: '77777777-7777-4777-8777-777777777777' }),
    ]);

    await service.list(query());

    expect(providers.find).toHaveBeenCalledTimes(1);
    expect(providers.find).toHaveBeenCalledWith({
      where: [{ organizationId: PROVIDER }],
      select: { organizationId: true, legalName: true },
    });
  });

  it('skips the lookups on an empty page', async () => {
    const { service, providers, catalogue } = build([]);

    const page = await service.list(query());

    expect(page.items).toEqual([]);
    expect(providers.find).not.toHaveBeenCalled();
    expect(catalogue.findTool).not.toHaveBeenCalled();
  });
});

describe('the Penalties list cursor', () => {
  it('round-trips a position', () => {
    const key = {
      k1: '2026-10-23T10:00:00.123456Z',
      k2: '-5000000',
      k3: '-1790237340.123456',
      id: PROPOSAL,
    };
    expect(decodeKey(encodeKey(key))).toEqual(key);
  });

  it.each([
    ['a part that would not cast', { k1: "2026'; DROP TABLE x;--", k2: '0', k3: '0' }],
    ['a non-numeric amount', { k1: 'infinity', k2: '1e9', k3: '0' }],
    ['a local time without zone', { k1: '2026-10-23 10:00:00', k2: '0', k3: '0' }],
  ])('refuses %s with a 400', (_label, parts) => {
    const cursor = encodeKey({ ...parts, id: PROPOSAL } as never);
    expect(() => decodeKey(cursor)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('refuses an id that is not a uuid', () => {
    const cursor = encodeKey({ k1: 'infinity', k2: '0', k3: '0', id: 'nope' });
    expect(() => decodeKey(cursor)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('refuses a cursor taken from another list', () => {
    const cursor = encodeCursor(
      { sortValue: '2026-10-23T10:00:00.000Z', id: PROPOSAL },
      'platformDecisionDueAt:desc',
    );
    expect(() => decodeKey(cursor)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('refuses garbage', () => {
    expect(() => decodeKey('not-a-cursor')).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

describe('ListOperatorCasesQueryDto', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const parse = (input: Record<string, unknown>) =>
    pipe.transform(input, {
      type: 'query',
      metatype: ListOperatorCasesQueryDto,
    }) as Promise<ListOperatorCasesQueryDto>;

  it('reads a comma list of statuses', async () => {
    await expect(parse({ status: 'CHAIN_DISPUTED, CANCEL_REQUESTED' })).resolves.toMatchObject({
      status: ['CHAIN_DISPUTED', 'CANCEL_REQUESTED'],
      limit: 25,
    });
  });

  it('refuses an unknown status', async () => {
    await expect(parse({ status: 'CHAIN_DISPUTED,UPHELD' })).rejects.toBeDefined();
  });

  it('refuses a provider id that is not a uuid', async () => {
    await expect(parse({ providerId: "x' OR 1=1" })).rejects.toBeDefined();
  });

  it.each(['0', '101', 'abc'])('refuses limit=%s', async (limit) => {
    await expect(parse({ limit })).rejects.toBeDefined();
  });

  it('accepts the cap', async () => {
    await expect(parse({ limit: '100' })).resolves.toMatchObject({ limit: 100 });
  });

  it.each(['sort', 'order', 'search', 'from', 'organizationId'])(
    'refuses %s: the order is fixed and the list has no tenant parameter',
    async (key) => {
      await expect(parse({ [key]: 'x' })).rejects.toBeDefined();
    },
  );
});

describe('GET /operator/cases', () => {
  it('is a GET on the static `cases` path, so it never meets the `:proposalId` UUID pipe', () => {
    const handler = OperatorCasesController.prototype.listCases;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('cases');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
  });

  it('sits behind the operator guards like every route of the controller', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, OperatorCasesController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([OperatorAuthGuard, OperatorRolesGuard]));
  });

  it('hands the query to the list service and returns its page', async () => {
    const page = { items: [], pageInfo: { nextCursor: null, hasMore: false } };
    const list = jest.fn().mockResolvedValue(page);
    const controller = new OperatorCasesController({} as never, {} as never, { list } as never);
    const q = query({ status: [OperatorCaseStatus.EXECUTED] });

    await expect(controller.listCases(q)).resolves.toBe(page);
    expect(list).toHaveBeenCalledWith(q);
  });
});

describe('SlashProposalRepository.findOperatorCasePage', () => {
  function repository() {
    const query = jest.fn().mockResolvedValue([]);
    const repo = Object.create(SlashProposalRepository.prototype) as SlashProposalRepository;
    Object.defineProperty(repo, 'manager', { value: { query } });
    return { repo, query };
  }

  it('binds every input as a parameter, never into the statement', async () => {
    const { repo, query } = repository();
    await repo.findOperatorCasePage({
      statuses: [OperatorCaseStatus.CHAIN_DISPUTED],
      providerId: PROVIDER,
      after: { k1: 'infinity', k2: '0', k3: '-1', id: PROPOSAL },
      limit: 26,
    });

    const [sql, args] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain(PROVIDER);
    expect(sql).not.toContain(PROPOSAL);
    expect(args).toEqual([
      2592000,
      PROVIDER,
      ['CHAIN_DISPUTED'],
      'infinity',
      '0',
      '-1',
      PROPOSAL,
      26,
    ]);
    expect(sql).toContain('p.provider_id = $2::uuid');
    expect(sql).toContain('d.status = ANY($3::text[])');
    expect(sql).toContain(
      '(d.k1, d.k2, d.k3, d.id) > ($4::timestamptz, $5::numeric, $6::numeric, $7::uuid)',
    );
    expect(sql).toMatch(/ORDER BY d\.k1, d\.k2, d\.k3, d\.id\s+LIMIT \$8/);
  });

  it('reads nothing of the binding but its tool id, and no secret column of the proposal', async () => {
    const { repo, query } = repository();
    await repo.findOperatorCasePage({ limit: 26 });

    const [sql, args] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('b.tool_id AS "toolId"');
    expect(sql).not.toMatch(/b\.(endpoint|request_mapping|response_mapping|\*)/);
    expect(sql).not.toMatch(
      /beneficiary|signature|decided_by|seconded_by|chain_last_error|root_cause/,
    );
    expect(sql).not.toContain('WHERE p.provider_id');
    expect(args).toEqual([2592000, 26]);
  });
});
