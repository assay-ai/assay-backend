import { AgentEntity } from '@database/postgres/entities/agent.entity';
import { AccountErrorCode } from '@modules/account/errors/account.errors';
import { AgentsService } from '@modules/account/services/agents.service';
import { toAccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { CursorPageDto, SortDirection } from '@shared/api';

import { buildAgent } from '../auth/helpers/fake-agent-repository';
import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_AGENT_ID = '33333333-3333-3333-3333-333333333333';
const SOLANA_DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const ACCOUNT = toAccountId(SOLANA_DEVNET, 'AgentAccount1111111111111111111111111111111');
const DEFAULT_CHAIN_ID = CHAIN_IDS.SOLANA_MAINNET;

function baseQuery(overrides: Record<string, unknown> = {}) {
  return Object.assign({ limit: 25, order: SortDirection.DESC }, overrides) as any;
}

function buildHarness(
  rows: AgentEntity[],
  counts: Record<string, number> = {},
  defaultChainId: string = DEFAULT_CHAIN_ID,
) {
  const agents = {
    list: jest.fn().mockResolvedValue(new CursorPageDto(rows, null)),
  };

  const credentials = {
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue(
          Object.entries(counts).map(([agentId, count]) => ({ agentId, count: String(count) })),
        ),
    }),
  };

  const config = { get: jest.fn().mockReturnValue(defaultChainId) };

  const service = new AgentsService(
    agents as any,
    credentials as any,
    config as any,
    {} as any,
    {} as any,
  );
  return { service, agents, credentials, config };
}

describe('AgentsService.list', () => {
  it('passes the caller organization down to the repository — it is the repository, not this service, that scopes the read', async () => {
    const { service, agents } = buildHarness([]);
    const query = baseQuery();

    await service.list(ORGANIZATION_ID, query);

    expect(agents.list).toHaveBeenCalledWith(ORGANIZATION_ID, query);
  });

  it('an agent with a linked wallet returns its real agentAccount and chainId', async () => {
    const agent = buildAgent({
      id: AGENT_ID,
      organizationId: ORGANIZATION_ID,
      primaryAccountId: ACCOUNT,
      chainId: SOLANA_DEVNET,
    });
    const { service } = buildHarness([agent]);

    const page = await service.list(ORGANIZATION_ID, baseQuery());

    expect(page.items[0]).toMatchObject({
      agentId: AGENT_ID,
      agentAccount: ACCOUNT,
      chainId: SOLANA_DEVNET,
    });
  });

  it('an agent with no linked wallet returns agentAccount: null and the configured default chainId', async () => {
    const agent = buildAgent({
      id: AGENT_ID,
      organizationId: ORGANIZATION_ID,
      primaryAccountId: null,
      chainId: null,
    });
    const { service, config } = buildHarness([agent]);

    const page = await service.list(ORGANIZATION_ID, baseQuery());

    expect(page.items[0].agentAccount).toBeNull();
    expect(page.items[0].chainId).toBe(DEFAULT_CHAIN_ID);
    expect(config.get).toHaveBeenCalledWith('auth.privy.defaultChainId', '');
  });

  it('groups credential counts by agents.id, and an agent with no credentials reports zero', async () => {
    const withCredentials = buildAgent({ id: AGENT_ID, organizationId: ORGANIZATION_ID });
    const withoutCredentials = buildAgent({ id: OTHER_AGENT_ID, organizationId: ORGANIZATION_ID });
    const { service } = buildHarness([withCredentials, withoutCredentials], { [AGENT_ID]: 3 });

    const page = await service.list(ORGANIZATION_ID, baseQuery());

    const byId = new Map(page.items.map((item) => [item.agentId, item.credentialCount]));
    expect(byId.get(AGENT_ID)).toBe(3);
    expect(byId.get(OTHER_AGENT_ID)).toBe(0);
  });

  it('there is no FK between agent_credentials and agents — a count can land on the wrong id and read as zero here', async () => {
    // `agent_credentials.agent_id` seeded under an id that names no row in
    // `agents` (a demo credential minted before the table existed, say) is
    // simply never joined: it does not error, and it does not attach to any
    // agent in the page. This is that exact shape, made explicit rather than
    // left to be discovered later.
    const agent = buildAgent({ id: AGENT_ID, organizationId: ORGANIZATION_ID });
    const strayId = '99999999-9999-9999-9999-999999999999';
    const { service } = buildHarness([agent], { [strayId]: 5 });

    const page = await service.list(ORGANIZATION_ID, baseQuery());

    expect(page.items[0].credentialCount).toBe(0);
  });

  it('never queries credential counts for an empty page', async () => {
    const { service, credentials } = buildHarness([]);
    await service.list(ORGANIZATION_ID, baseQuery());

    expect(credentials.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('an organization with no agents gets an empty page, not an error', async () => {
    const { service } = buildHarness([]);
    const page = await service.list(ORGANIZATION_ID, baseQuery());

    expect(page).toEqual({ items: [], pageInfo: { nextCursor: null, hasMore: false } });
  });
});

describe('AgentsService.rename', () => {
  const ACTOR = { type: 'user' as const, id: 'login-session-1' };

  function buildRenameHarness(row: AgentEntity | null) {
    const base = buildHarness([], { [AGENT_ID]: 2 });
    const agents = { findById: jest.fn().mockResolvedValue(row) };
    const manager = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    const dataSource = {
      transaction: jest.fn(async (work: (m: unknown) => unknown) => work(manager)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new AgentsService(
      agents as any,
      base.credentials as any,
      base.config as any,
      dataSource as any,
      audit as any,
    );
    return { service, agents, manager, dataSource, audit };
  }

  it('writes only the label, scoped to the caller organization, and returns the renamed agent', async () => {
    const agent = buildAgent({
      id: AGENT_ID,
      organizationId: ORGANIZATION_ID,
      label: 'dan@example.com',
    });
    const { service, manager } = buildRenameHarness(agent);

    const renamed = await service.rename(ORGANIZATION_ID, AGENT_ID, 'Research bot', ACTOR);

    expect(manager.update).toHaveBeenCalledTimes(1);
    expect(manager.update).toHaveBeenCalledWith(
      AgentEntity,
      { id: AGENT_ID, organizationId: ORGANIZATION_ID },
      { label: 'Research bot' },
    );
    expect(renamed).toMatchObject({ agentId: AGENT_ID, label: 'Research bot', credentialCount: 2 });
  });

  it('records agent.renamed with the old and new label in the same transaction', async () => {
    const agent = buildAgent({ id: AGENT_ID, organizationId: ORGANIZATION_ID, label: 'My agent' });
    const { service, manager, audit } = buildRenameHarness(agent);

    await service.rename(ORGANIZATION_ID, AGENT_ID, 'Laptop agent', ACTOR);

    expect(audit.record).toHaveBeenCalledWith(manager, {
      organizationId: ORGANIZATION_ID,
      actor: ACTOR,
      action: 'agent.renamed',
      resourceType: 'agent',
      resourceId: AGENT_ID,
      before: { label: 'My agent' },
      after: { label: 'Laptop agent' },
    });
  });

  it('refuses an agent in another organization with the same 404 as a missing one, and writes nothing', async () => {
    const foreign = buildAgent({
      id: AGENT_ID,
      organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    const { service, manager, audit } = buildRenameHarness(foreign);

    await expectErrorCodeAsync(
      () => service.rename(ORGANIZATION_ID, AGENT_ID, 'Mine now', ACTOR),
      AccountErrorCode.ACCOUNT_AGENT_NOT_FOUND,
    );
    expect(manager.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses an unknown agent', async () => {
    const { service, manager } = buildRenameHarness(null);

    await expectErrorCodeAsync(
      () => service.rename(ORGANIZATION_ID, AGENT_ID, 'Ghost', ACTOR),
      AccountErrorCode.ACCOUNT_AGENT_NOT_FOUND,
    );
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('refuses with 404 and no audit row when the row went away before the write', async () => {
    const agent = buildAgent({ id: AGENT_ID, organizationId: ORGANIZATION_ID, label: 'My agent' });
    const { service, manager, audit } = buildRenameHarness(agent);
    manager.update.mockResolvedValueOnce({ affected: 0 });

    await expectErrorCodeAsync(
      () => service.rename(ORGANIZATION_ID, AGENT_ID, 'Too late', ACTOR),
      AccountErrorCode.ACCOUNT_AGENT_NOT_FOUND,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('is a no-op, with no audit row, when the label does not change', async () => {
    const agent = buildAgent({ id: AGENT_ID, organizationId: ORGANIZATION_ID, label: 'My agent' });
    const { service, dataSource, audit } = buildRenameHarness(agent);

    const same = await service.rename(ORGANIZATION_ID, AGENT_ID, 'My agent', ACTOR);

    expect(same.label).toBe('My agent');
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
