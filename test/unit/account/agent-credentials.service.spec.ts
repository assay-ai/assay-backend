import { Logger } from '@nestjs/common';

import { CredentialIssuedVia } from '@database/postgres/entities/agent-credential.entity';
import { OAuthAccessTokenEntity } from '@database/postgres/entities/oauth-access-token.entity';
import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';
import { AgentCredentialsService } from '@modules/account/services/agent-credentials.service';
import { OAuthClientTrust } from '@modules/oauth/domain/credential-client-view';
import { AccountErrorCode } from '@modules/account/errors/account.errors';
import { SortDirection } from '@shared/api';
import { digestToken } from '@shared/crypto/token-digest';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder } from './helpers/fake-query-builder';
import { AgentScope } from '@shared/auth/agent-scope';

const ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_AGENT_ID = '55555555-5555-5555-5555-555555555555';
const CREDENTIAL_ID = '33333333-3333-3333-3333-333333333333';
const ACTOR = { type: 'user' as const, id: 'cred-actor' };
const MCP = 'https://mcp.example.test';
const BUILTIN_CLIENT_ID = `${MCP}/oauth/clients/assay-mcp`;
const BUILTIN_ROW = '44444444-4444-4444-4444-444444444444';
const CIMD_ROW = '66666666-6666-6666-6666-666666666666';
const CIMD_CLIENT_ID = 'https://app.client.example.com/oauth/client.json';
const VENDOR_REDIRECT = 'https://app.client.example.com/callback';

const TRUST: OAuthClientTrust = {
  paymentClients: [BUILTIN_CLIENT_ID],
  verifiedClients: [
    { clientId: CIMD_CLIENT_ID, displayName: 'Example Vendor', vendorRedirects: [VENDOR_REDIRECT] },
  ],
};

function clientRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BUILTIN_ROW,
    clientId: BUILTIN_CLIENT_ID,
    kind: OAuthClientKind.BUILTIN,
    clientName: 'Assay app (assay-mcp)',
    redirectUris: ['http://127.0.0.1/callback'],
    ...overrides,
  };
}

function oauthCredentialRow(overrides: Record<string, unknown> = {}) {
  return credentialRow({
    name: 'Example app',
    issuedVia: CredentialIssuedVia.OAUTH,
    oauthClientId: BUILTIN_ROW,
    prefix: null,
    tokenHash: null,
    scopes: [],
    ...overrides,
  });
}

function baseQuery(overrides: Record<string, unknown> = {}) {
  return Object.assign({ limit: 25, order: SortDirection.DESC }, overrides) as any;
}

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CREDENTIAL_ID,
    agentId: AGENT_ID,
    name: 'CI deploy',
    issuedVia: CredentialIssuedVia.API_KEY,
    oauthClientId: null as string | null,
    prefix: 'assay_sk_live_abc123' as string | null,
    tokenHash: 'deadbeef' as string | null,
    scopes: ['tools:call'],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    revokedBy: null,
    rotatedFromId: null,
    createdAt: new Date('2026-08-10T10:00:00.000Z'),
    ...overrides,
  };
}

function buildHarness(
  rows: ReturnType<typeof credentialRow>[] = [],
  clients: ReturnType<typeof clientRow>[] = [clientRow()],
) {
  const fake = fakeQueryBuilder(rows);
  const credentials = {
    createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
    create: jest.fn((input: Record<string, unknown>) => ({ ...input })),
    save: jest.fn(async (entity: Record<string, unknown>) => ({
      id: CREDENTIAL_ID,
      createdAt: new Date('2026-08-10T10:00:00.000Z'),
      ...entity,
    })),
    findOneBy: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    clearPendingDelegate: jest.fn(async (): Promise<boolean> => false),
  };

  const agents = {
    findById: jest.fn(async (id: string) =>
      id === AGENT_ID ? { id, organizationId: ORGANIZATION_ID } : null,
    ),
  };

  // The writes go through the transaction's manager; credential writes forward
  // to the same spies the assertions below read, token writes to `tokenUpdates`.
  const tokenUpdates: Array<{ entity: unknown; criteria: unknown; values: unknown }> = [];
  const writeOrder: string[] = [];
  const tokenQueries: Array<{ sql: string; params: unknown[] }> = [];
  const manager = {
    save: jest.fn((_entity: unknown, row: Record<string, unknown>) => credentials.save(row)),
    update: jest.fn((entity: unknown, criteria: unknown, values: unknown) => {
      if (entity === OAuthAccessTokenEntity) {
        writeOrder.push((entity as { name: string }).name);
        tokenUpdates.push({ entity, criteria, values });
        return Promise.resolve({ affected: 1 });
      }
      writeOrder.push('AgentCredentialEntity');
      return (credentials.update as jest.Mock)(criteria, values);
    }),
    // The refresh-token cascade is raw SQL (`FOR UPDATE SKIP LOCKED`).
    // The post-commit sweep runs its own short transactions (`SET LOCAL
    // lock_timeout`, then one UPDATE each); those go to `sweepQuery`.
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SET LOCAL') || sql.includes('FROM "agent_credentials" c')) {
        inSweep = true;
        return sweepQuery(sql, params);
      }
      writeOrder.push('oauth_refresh_tokens');
      tokenQueries.push({ sql, params });
      return [];
    }),
  };
  const events: string[] = [];
  const sweeps: Array<{ sql: string; params: unknown[] }> = [];
  const lockTimeouts: string[] = [];
  let inSweep = false;
  const sweepQuery = jest.fn(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('SET LOCAL')) {
      lockTimeouts.push(sql);
      return [];
    }
    events.push('sweep');
    sweeps.push({ sql, params });
    return [];
  });
  const dataSource = {
    transaction: jest.fn(async (work: (m: unknown) => unknown) => {
      inSweep = false;
      const result = await work(manager);
      if (!inSweep) events.push('commit');
      return result;
    }),
  };
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    recordAfterCommit: jest.fn().mockResolvedValue(undefined),
  };
  const accessEpoch = {
    bump: jest.fn(async (organizationId: string) => {
      events.push(`bump:${organizationId}`);
    }),
  };
  const oauthClients = {
    findBy: jest.fn(async () => clients),
    findOneBy: jest.fn(async ({ id }: { id: string }) => clients.find((c) => c.id === id) ?? null),
  };

  // Nothing buffered unless a test says so: the row's `last_used_at` stands.
  const lastSeen = { pending: jest.fn(async () => new Map<string, Date>()) };
  const service = new AgentCredentialsService(
    credentials as any,
    agents as any,
    dataSource as any,
    audit as any,
    accessEpoch as any,
    oauthClients as any,
    TRUST,
    lastSeen as any,
  );
  return {
    service,
    lastSeen,
    fake,
    credentials,
    agents,
    manager,
    dataSource,
    audit,
    accessEpoch,
    oauthClients,
    tokenUpdates,
    tokenQueries,
    writeOrder,
    events,
    sweeps,
    sweepQuery,
    lockTimeouts,
  };
}

describe('AgentCredentialsService.list', () => {
  it('scopes to organization and agent', async () => {
    const { service, fake } = buildHarness();
    await service.list(ORGANIZATION_ID, AGENT_ID, baseQuery());

    expect(fake.wheres).toEqual([
      {
        sql: 'credential.organizationId = :organizationId',
        params: { organizationId: ORGANIZATION_ID },
      },
      { sql: 'credential.agentId = :agentId', params: { agentId: AGENT_ID } },
    ]);
  });

  it('never includes tokenHash on the wire', async () => {
    const { service } = buildHarness([credentialRow()]);
    const page = await service.list(ORGANIZATION_ID, AGENT_ID, baseQuery());

    expect(page.items[0]).not.toHaveProperty('tokenHash');
    expect(Object.keys(page.items[0])).toEqual([
      'id',
      'agentId',
      'name',
      'issuedVia',
      'oauthClient',
      'prefix',
      'scopes',
      'lastUsedAt',
      'expiresAt',
      'revokedAt',
      'rotatedFromId',
      // Agent payment delegation: the delegate key this credential proved it holds.
      'delegateAccount',
      'delegateBoundAt',
      'pendingDelegateAccount',
      'pendingDelegateRequestedAt',
      'createdAt',
    ]);
  });

  it('refuses an agent that does not exist with ACCOUNT_AGENT_NOT_FOUND, not an empty page (BUG-NF-02)', async () => {
    const { service, credentials } = buildHarness();

    await expectErrorCodeAsync(
      () => service.list(ORGANIZATION_ID, OTHER_AGENT_ID, baseQuery()),
      AccountErrorCode.ACCOUNT_AGENT_NOT_FOUND,
    );
    expect(credentials.createQueryBuilder).not.toHaveBeenCalled();
  });

  it("refuses another organization's agent with the same 404", async () => {
    const { service, agents } = buildHarness([credentialRow()]);
    agents.findById.mockResolvedValueOnce({
      id: AGENT_ID,
      organizationId: '99999999-9999-9999-9999-999999999999',
    });

    await expectErrorCodeAsync(
      () => service.list(ORGANIZATION_ID, AGENT_ID, baseQuery()),
      AccountErrorCode.ACCOUNT_AGENT_NOT_FOUND,
    );
  });

  it('still answers an empty page for an own agent with no credentials', async () => {
    const { service } = buildHarness([]);
    const page = await service.list(ORGANIZATION_ID, AGENT_ID, baseQuery());
    expect(page.items).toEqual([]);
  });
});

describe('AgentCredentialsService.list — buffered last_used_at (B1)', () => {
  it('shows the later of the row and the stamp not yet written', async () => {
    const stored = new Date('2026-10-20T10:00:00.000Z');
    const buffered = new Date('2026-10-20T10:00:07.000Z');
    const row = credentialRow({ lastUsedAt: stored });
    const { service, lastSeen } = buildHarness([row]);
    lastSeen.pending.mockResolvedValue(new Map([[`${ORGANIZATION_ID}:${row.id}`, buffered]]));

    const page = await service.list(ORGANIZATION_ID, AGENT_ID, baseQuery());

    expect(lastSeen.pending).toHaveBeenCalledWith('credential-use', [
      `${ORGANIZATION_ID}:${row.id}`,
    ]);
    expect(page.items[0].lastUsedAt).toEqual(buffered);
  });

  it('keeps the row stamp when nothing newer is buffered', async () => {
    const stored = new Date('2026-10-20T10:00:00.000Z');
    const { service } = buildHarness([credentialRow({ lastUsedAt: stored })]);
    const page = await service.list(ORGANIZATION_ID, AGENT_ID, baseQuery());
    expect(page.items[0].lastUsedAt).toEqual(stored);
  });
});

describe('AgentCredentialsService.list — issuedVia and oauthClient (spec §7.10 item 4)', () => {
  it('oauthClient null for API keys', async () => {
    const { service, oauthClients } = buildHarness([credentialRow()]);
    const page = await service.list(ORGANIZATION_ID, AGENT_ID, baseQuery());

    expect(page.items[0]).toMatchObject({
      issuedVia: 'API_KEY',
      oauthClient: null,
      prefix: 'assay_sk_live_abc123',
    });
    // No client lookup for a page without grants.
    expect(oauthClients.findBy).not.toHaveBeenCalled();
  });

  it('verified false for builtin; the built-in client is the payment client', async () => {
    const { service } = buildHarness([oauthCredentialRow()]);
    const page = await service.list(ORGANIZATION_ID, AGENT_ID, baseQuery());

    expect(page.items[0]).toMatchObject({ issuedVia: 'OAUTH', prefix: null });
    expect(page.items[0].oauthClient).toEqual({
      clientId: BUILTIN_CLIENT_ID,
      name: 'Assay app (assay-mcp)',
      registrableDomain: null,
      verified: false,
      paymentClient: true,
    });
  });

  it('a listed CIMD client whose every redirect is a vendor redirect is verified, under its listed name', async () => {
    const cimd = clientRow({
      id: CIMD_ROW,
      clientId: CIMD_CLIENT_ID,
      kind: OAuthClientKind.CIMD,
      clientName: 'Self-declared name',
      redirectUris: [VENDOR_REDIRECT],
    });
    const { service } = buildHarness([oauthCredentialRow({ oauthClientId: CIMD_ROW })], [cimd]);
    const page = await service.list(ORGANIZATION_ID, AGENT_ID, baseQuery());

    expect(page.items[0].oauthClient).toEqual({
      clientId: CIMD_CLIENT_ID,
      name: 'Example Vendor',
      registrableDomain: 'example.com',
      verified: true,
      paymentClient: false,
    });
  });

  it('a listed CIMD client that also registers a loopback redirect is not verified', async () => {
    const cimd = clientRow({
      id: CIMD_ROW,
      clientId: CIMD_CLIENT_ID,
      kind: OAuthClientKind.CIMD,
      clientName: 'Self-declared name',
      redirectUris: [VENDOR_REDIRECT, 'http://127.0.0.1/callback'],
    });
    const { service } = buildHarness([oauthCredentialRow({ oauthClientId: CIMD_ROW })], [cimd]);
    const page = await service.list(ORGANIZATION_ID, AGENT_ID, baseQuery());

    expect(page.items[0].oauthClient).toMatchObject({
      name: 'Self-declared name',
      verified: false,
      paymentClient: false,
      registrableDomain: 'example.com',
    });
  });

  it('a DCR client is never verified and proves no domain', async () => {
    const dcr = clientRow({
      id: CIMD_ROW,
      clientId: 'dcr_abcdefghijklmnopqrstuv',
      kind: OAuthClientKind.DCR,
      clientName: 'Some app',
      redirectUris: [VENDOR_REDIRECT],
    });
    const { service } = buildHarness([oauthCredentialRow({ oauthClientId: CIMD_ROW })], [dcr]);
    const page = await service.list(ORGANIZATION_ID, AGENT_ID, baseQuery());

    expect(page.items[0].oauthClient).toEqual({
      clientId: 'dcr_abcdefghijklmnopqrstuv',
      name: 'Some app',
      registrableDomain: null,
      verified: false,
      paymentClient: false,
    });
  });

  it.each([
    [
      'a DCR client',
      clientRow({
        id: CIMD_ROW,
        clientId: 'dcr_abcdefghijklmnopqrstuv',
        kind: OAuthClientKind.DCR,
        redirectUris: [VENDOR_REDIRECT],
      }),
    ],
    [
      'a listed CIMD client with a non-vendor https redirect',
      clientRow({
        id: CIMD_ROW,
        clientId: CIMD_CLIENT_ID,
        kind: OAuthClientKind.CIMD,
        redirectUris: ['https://app.client.example.com/other-callback'],
      }),
    ],
    [
      'a listed CIMD client with no redirect',
      clientRow({
        id: CIMD_ROW,
        clientId: CIMD_CLIENT_ID,
        kind: OAuthClientKind.CIMD,
        redirectUris: [],
      }),
    ],
    [
      "another deployment's built-in client",
      clientRow({ id: CIMD_ROW, clientId: 'https://mcp.other.example/oauth/clients/assay-mcp' }),
    ],
    [
      'a CIMD row whose clientId is the built-in id',
      clientRow({ id: CIMD_ROW, clientId: BUILTIN_CLIENT_ID, kind: OAuthClientKind.CIMD }),
    ],
    [
      'a DCR row whose clientId is the built-in id',
      clientRow({ id: CIMD_ROW, clientId: BUILTIN_CLIENT_ID, kind: OAuthClientKind.DCR }),
    ],
    [
      'an unlisted CIMD client',
      clientRow({
        id: CIMD_ROW,
        clientId: 'https://other.example.org/oauth/client.json',
        kind: OAuthClientKind.CIMD,
        redirectUris: [VENDOR_REDIRECT],
      }),
    ],
    [
      'a DCR row that carries a listed id',
      clientRow({
        id: CIMD_ROW,
        clientId: CIMD_CLIENT_ID,
        kind: OAuthClientKind.DCR,
        redirectUris: [VENDOR_REDIRECT],
      }),
    ],
  ])('%s: neither verified nor a payment client', async (_label, row) => {
    const { service } = buildHarness([oauthCredentialRow({ oauthClientId: CIMD_ROW })], [row]);
    const page = await service.list(ORGANIZATION_ID, AGENT_ID, baseQuery());

    expect(page.items[0].oauthClient).toMatchObject({ verified: false, paymentClient: false });
  });

  it('looks up the clients of a page in one query', async () => {
    const { service, oauthClients } = buildHarness([
      oauthCredentialRow({ id: 'a' }),
      oauthCredentialRow({ id: 'b' }),
      credentialRow({ id: 'c' }),
    ]);
    await service.list(ORGANIZATION_ID, AGENT_ID, baseQuery());

    expect(oauthClients.findBy).toHaveBeenCalledTimes(1);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe('AgentCredentialsService.create', () => {
  it('refuses an agent that does not exist, before minting anything', async () => {
    const { service, credentials } = buildHarness();

    await expectErrorCodeAsync(
      () => service.create(ORGANIZATION_ID, OTHER_AGENT_ID, { name: 'orphan' }, ACTOR),
      AccountErrorCode.ACCOUNT_AGENT_NOT_FOUND,
    );
    expect(credentials.save).not.toHaveBeenCalled();
  });

  it("refuses another organization's agent with the same 404", async () => {
    const { service, credentials, agents } = buildHarness();
    agents.findById.mockResolvedValueOnce({
      id: AGENT_ID,
      organizationId: '99999999-9999-9999-9999-999999999999',
    });

    await expectErrorCodeAsync(
      () => service.create(ORGANIZATION_ID, AGENT_ID, { name: 'cross-tenant' }, ACTOR),
      AccountErrorCode.ACCOUNT_AGENT_NOT_FOUND,
    );
    expect(credentials.save).not.toHaveBeenCalled();
  });

  it('returns the full token exactly once and stores only its hash', async () => {
    const { service, credentials } = buildHarness();

    const response = await service.create(ORGANIZATION_ID, AGENT_ID, { name: 'CI deploy' }, ACTOR);

    expect(response.token).toMatch(/^assay_sk_live_/);
    expect(response.token.startsWith(response.prefix)).toBe(true);
    expect(response.prefix).toHaveLength(20);
    expect(response.prefix.length).toBeLessThan(response.token.length);

    const created = credentials.create.mock.calls[0][0];
    expect(created.tokenHash).not.toBe(response.token);
    expect(created.tokenHash).toHaveLength(64); // sha256 hex
    expect(created).not.toHaveProperty('token');
  });

  it('defaults to tools:call payments activity:read and a 90-day expiry', async () => {
    const { service, credentials } = buildHarness();
    const before = Date.now();
    const response = await service.create(ORGANIZATION_ID, AGENT_ID, { name: 'default' }, ACTOR);

    expect(response.scopes).toEqual(['tools:call', 'payments', 'activity:read']);
    expect(credentials.create.mock.calls[0][0].scopes).toEqual([
      'tools:call',
      'payments',
      'activity:read',
    ]);
    const lifetime = (response.expiresAt as Date).getTime() - before;
    expect(lifetime).toBeGreaterThanOrEqual(90 * DAY_MS - 5_000);
    expect(lifetime).toBeLessThanOrEqual(90 * DAY_MS + 5_000);
  });

  it('keeps exactly the scopes asked for (reports:write only when named)', async () => {
    const { service } = buildHarness();

    const ci = await service.create(
      ORGANIZATION_ID,
      AGENT_ID,
      { name: 'free only', scopes: [AgentScope.TOOLS_CALL] },
      ACTOR,
    );
    expect(ci.scopes).toEqual(['tools:call']);

    const reporter = await service.create(
      ORGANIZATION_ID,
      AGENT_ID,
      {
        name: 'sdk',
        scopes: [AgentScope.TOOLS_CALL, AgentScope.PAYMENTS, AgentScope.REPORTS_WRITE],
      },
      ACTOR,
    );
    expect(reporter.scopes).toEqual(['tools:call', 'payments', 'reports:write']);

    const reader = await service.create(
      ORGANIZATION_ID,
      AGENT_ID,
      { name: 'read only', scopes: [AgentScope.ACTIVITY_READ] },
      ACTOR,
    );
    expect(reader.scopes).toEqual(['activity:read']);
  });

  it('refuses payments without tools:call, before minting anything', async () => {
    const { service, credentials } = buildHarness();

    await expectErrorCodeAsync(
      () =>
        service.create(
          ORGANIZATION_ID,
          AGENT_ID,
          { name: 'pay only', scopes: [AgentScope.PAYMENTS, AgentScope.ACTIVITY_READ] },
          ACTOR,
        ),
      AccountErrorCode.ACCOUNT_CREDENTIAL_SCOPES_INVALID,
    );
    expect(credentials.save).not.toHaveBeenCalled();
  });

  it('accepts an expiry up to 365 days away', async () => {
    const { service } = buildHarness();
    const expiresAt = new Date(Date.now() + 365 * DAY_MS - 60_000);

    const response = await service.create(
      ORGANIZATION_ID,
      AGENT_ID,
      { name: 'a year', expiresAt },
      ACTOR,
    );

    expect(response.expiresAt).toEqual(expiresAt);
  });

  it.each([
    ['in the past', -60_000],
    ['now', 0],
    ['more than 365 days away', 365 * DAY_MS + 60_000],
  ])('refuses an expiry %s (ACCOUNT_CREDENTIAL_EXPIRY_INVALID)', async (_label, offset) => {
    const { service, credentials } = buildHarness();

    await expectErrorCodeAsync(
      () =>
        service.create(
          ORGANIZATION_ID,
          AGENT_ID,
          { name: 'bad expiry', expiresAt: new Date(Date.now() + offset) },
          ACTOR,
        ),
      AccountErrorCode.ACCOUNT_CREDENTIAL_EXPIRY_INVALID,
    );
    expect(credentials.save).not.toHaveBeenCalled();
  });

  it('two credentials for the same agent get different tokens and different hashes', async () => {
    const { service, credentials } = buildHarness();

    await service.create(ORGANIZATION_ID, AGENT_ID, { name: 'one' }, ACTOR);
    await service.create(ORGANIZATION_ID, AGENT_ID, { name: 'two' }, ACTOR);

    const [first, second] = credentials.create.mock.calls.map((call) => call[0]);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });

  it('scopes the written row to the caller organization and named agent', async () => {
    const { service, credentials } = buildHarness();
    await service.create(ORGANIZATION_ID, AGENT_ID, { name: 'CI deploy' }, ACTOR);

    const created = credentials.create.mock.calls[0][0];
    expect(created.organizationId).toBe(ORGANIZATION_ID);
    expect(created.agentId).toBe(AGENT_ID);
  });
});

/** M3: the owner discards the payment key a credential waits with. */
describe('AgentCredentialsService.discardPendingDelegate', () => {
  const PENDING = 'eip155:46630:0x00000000000000000000000000000000000000d2';

  it('returns ACCOUNT_CREDENTIAL_NOT_FOUND for another agent, and clears nothing', async () => {
    const { service, credentials } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow({ agentId: OTHER_AGENT_ID }));

    await expectErrorCodeAsync(
      () => service.discardPendingDelegate(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR),
      AccountErrorCode.ACCOUNT_CREDENTIAL_NOT_FOUND,
    );
    expect(credentials.clearPendingDelegate).not.toHaveBeenCalled();
  });

  it('clears the pending key in its own organization and records who discarded which key', async () => {
    const { service, credentials, audit } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow({ pendingDelegateAccount: PENDING }));
    credentials.clearPendingDelegate.mockResolvedValueOnce(true);

    await service.discardPendingDelegate(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    expect(credentials.clearPendingDelegate).toHaveBeenCalledWith(ORGANIZATION_ID, CREDENTIAL_ID);
    expect(audit.recordAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        action: 'credential.pending_delegate_discarded',
        resourceId: CREDENTIAL_ID,
        before: { pendingDelegateAccount: PENDING },
        after: { pendingDelegateAccount: null },
      }),
    );
  });

  it('is idempotent: nothing pending, nothing recorded', async () => {
    const { service, credentials, audit } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow());

    await service.discardPendingDelegate(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    expect(audit.recordAfterCommit).not.toHaveBeenCalled();
  });
});

describe('AgentCredentialsService.revoke', () => {
  it('returns ACCOUNT_CREDENTIAL_NOT_FOUND for a cross-organization or missing id', async () => {
    const { service, credentials } = buildHarness();
    credentials.findOneBy.mockResolvedValue(null);

    await expectErrorCodeAsync(
      () => service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR),
      AccountErrorCode.ACCOUNT_CREDENTIAL_NOT_FOUND,
    );
  });

  it('returns ACCOUNT_CREDENTIAL_NOT_FOUND when the credential belongs to a different agent', async () => {
    const { service, credentials } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow({ agentId: OTHER_AGENT_ID }));

    await expectErrorCodeAsync(
      () => service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR),
      AccountErrorCode.ACCOUNT_CREDENTIAL_NOT_FOUND,
    );
    expect(credentials.update).not.toHaveBeenCalled();
  });

  it('sets revoked_at and revoked_by rather than deleting the row', async () => {
    const { service, credentials, tokenUpdates, tokenQueries } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow());

    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    expect(credentials.update).toHaveBeenCalledWith(
      { organizationId: ORGANIZATION_ID, id: CREDENTIAL_ID, revokedAt: expect.anything() },
      { revokedAt: expect.any(Date), revokedBy: 'cred-actor' },
    );
    // An API key has no OAuth tokens.
    expect(tokenUpdates).toEqual([]);
    expect(tokenQueries).toEqual([]);
  });

  it('invalidates cached access after commit, for an API key too', async () => {
    const { service, credentials, events } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow());

    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    expect(events).toEqual(['commit', `bump:${ORGANIZATION_ID}`]);
  });

  it('OAuth: revokes every refresh and access token of the grant in the same transaction, after the credential row', async () => {
    const { service, credentials, tokenUpdates, tokenQueries, writeOrder, dataSource, events } =
      buildHarness();
    credentials.findOneBy.mockResolvedValue(oauthCredentialRow());

    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    // One transaction for the cascade, then one short one per sweep statement.
    expect(dataSource.transaction).toHaveBeenCalledTimes(3);
    const revokedAt = (credentials.update.mock.calls[0][1] as { revokedAt: Date }).revokedAt;
    expect(tokenQueries).toHaveLength(1);
    // A refresh token a rotation holds is skipped, never waited for: the
    // rotation finds the credential revoked and revokes its own token.
    expect(tokenQueries[0].sql).toMatch(/UPDATE "oauth_refresh_tokens" SET "revoked_at"/);
    expect(tokenQueries[0].sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(tokenQueries[0].params).toEqual([ORGANIZATION_ID, CREDENTIAL_ID, revokedAt]);
    expect(tokenUpdates).toEqual([
      {
        entity: OAuthAccessTokenEntity,
        criteria: {
          organizationId: ORGANIZATION_ID,
          credentialId: CREDENTIAL_ID,
          revokedAt: expect.anything(),
        },
        values: { revokedAt },
      },
    ]);
    // The same order as OAuthGrantWriter.revokeInTransaction.
    expect(writeOrder).toEqual([
      'AgentCredentialEntity',
      'oauth_refresh_tokens',
      'OAuthAccessTokenEntity',
    ]);
    // After commit: the bump, then the sweep of any token a rotation held.
    expect(events).toEqual(['commit', `bump:${ORGANIZATION_ID}`, 'sweep', 'sweep']);
  });

  it('OAuth: audits credential.revoked naming the credential and the client, never a token', async () => {
    const { service, credentials, audit, manager } = buildHarness();
    credentials.findOneBy.mockResolvedValue(oauthCredentialRow());

    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    const revokedAt = (credentials.update.mock.calls[0][1] as { revokedAt: Date }).revokedAt;
    expect(audit.record).toHaveBeenCalledWith(manager, {
      organizationId: ORGANIZATION_ID,
      actor: ACTOR,
      action: 'credential.revoked',
      resourceType: 'agent_credential',
      resourceId: CREDENTIAL_ID,
      before: { revokedAt: null },
      after: {
        revokedAt: revokedAt.toISOString(),
        name: 'Example app',
        issuedVia: 'OAUTH',
        clientId: BUILTIN_CLIENT_ID,
      },
    });
  });

  it('no bump when the transaction fails', async () => {
    const { service, credentials, audit, accessEpoch } = buildHarness();
    credentials.findOneBy.mockResolvedValue(oauthCredentialRow());
    audit.record.mockRejectedValue(new Error('audit down'));

    await expect(service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR)).rejects.toThrow(
      'audit down',
    );
    expect(accessEpoch.bump).not.toHaveBeenCalled();
  });

  it('a concurrent revoke that won: no token writes, no second audit entry and no bump', async () => {
    const { service, credentials, audit, accessEpoch, tokenQueries, tokenUpdates } = buildHarness();
    credentials.findOneBy.mockResolvedValue(oauthCredentialRow());
    credentials.update.mockResolvedValue({ affected: 0 });

    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    expect(tokenQueries).toEqual([]);
    expect(tokenUpdates).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
    expect(accessEpoch.bump).not.toHaveBeenCalled();
  });

  it('OAuth: sweeps the refresh then the access tokens of the revoked credential after commit', async () => {
    const { service, credentials, sweeps, lockTimeouts } = buildHarness();
    credentials.findOneBy.mockResolvedValue(oauthCredentialRow());

    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    // Each statement is bounded by its own lock timeout.
    expect(lockTimeouts).toEqual([
      "SET LOCAL lock_timeout = '5000ms'",
      "SET LOCAL lock_timeout = '5000ms'",
    ]);
    expect(sweeps.map((sweep) => sweep.sql.match(/UPDATE "(\w+)"/)?.[1])).toEqual([
      'oauth_refresh_tokens',
      'oauth_access_tokens',
    ]);
    for (const sweep of sweeps) {
      expect(sweep.sql).toMatch(/c\."revoked_at" IS NOT NULL AND t\."revoked_at" IS NULL/);
      expect(sweep.params).toEqual([CREDENTIAL_ID]);
    }
  });

  it('a failed sweep is logged, not thrown, and does not skip the bump', async () => {
    const { service, credentials, sweepQuery, accessEpoch } = buildHarness();
    credentials.findOneBy.mockResolvedValue(oauthCredentialRow());
    sweepQuery.mockRejectedValue(new Error('canceling statement due to lock timeout'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR),
      ).resolves.toBeUndefined();

      expect(accessEpoch.bump).toHaveBeenCalledWith(ORGANIZATION_ID);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('post-commit token sweep failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('an already-revoked grant: nothing written, but the sweep still finishes skipped tokens', async () => {
    const { service, credentials, audit, accessEpoch, sweeps } = buildHarness();
    credentials.findOneBy.mockResolvedValue(oauthCredentialRow({ revokedAt: new Date() }));

    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    expect(credentials.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(accessEpoch.bump).not.toHaveBeenCalled();
    expect(sweeps).toHaveLength(2);
  });

  it('an API key is never swept: it has no OAuth tokens', async () => {
    const { service, credentials, sweeps } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow());

    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    expect(sweeps).toEqual([]);
  });

  it('is idempotent — revoking an already-revoked credential does not overwrite the original time', async () => {
    const { service, credentials } = buildHarness();
    credentials.findOneBy.mockResolvedValue(
      credentialRow({ revokedAt: new Date('2026-08-01T00:00:00.000Z'), revokedBy: 'someone-else' }),
    );

    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    expect(credentials.update).not.toHaveBeenCalled();
  });
});

describe('AgentCredentialsService — audit log (BUG-R2-B4-01)', () => {
  it('records credential.created in the transaction that saves the credential', async () => {
    const { service, audit, manager, dataSource } = buildHarness();

    const response = await service.create(
      ORGANIZATION_ID,
      AGENT_ID,
      { name: 'CI deploy', scopes: [AgentScope.TOOLS_CALL] },
      ACTOR,
    );

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(manager, {
      organizationId: ORGANIZATION_ID,
      actor: ACTOR,
      action: 'credential.created',
      resourceType: 'agent_credential',
      resourceId: CREDENTIAL_ID,
      before: null,
      after: {
        agentId: AGENT_ID,
        name: 'CI deploy',
        scopes: ['tools:call'],
        expiresAt: expect.any(String),
        issuedVia: 'API_KEY',
        clientId: null,
        replaces: null,
      },
    });

    // Neither the token, its stored prefix nor its hash is in the entry.
    const recorded = JSON.stringify(audit.record.mock.calls[0][1]);
    expect(recorded).not.toContain(response.token);
    expect(recorded).not.toContain(response.prefix);
    expect(recorded).not.toContain(digestToken(response.token));
  });

  it('fails the create when the audit entry cannot be recorded', async () => {
    const { service, audit } = buildHarness();
    audit.record.mockRejectedValue(new Error('audit down'));

    await expect(
      service.create(ORGANIZATION_ID, AGENT_ID, { name: 'CI deploy' }, ACTOR),
    ).rejects.toThrow('audit down');
  });

  it('records credential.revoked in the transaction that revokes it', async () => {
    const { service, credentials, audit, manager } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow());

    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    const revokedAt = (credentials.update.mock.calls[0][1] as { revokedAt: Date }).revokedAt;
    expect(audit.record).toHaveBeenCalledWith(manager, {
      organizationId: ORGANIZATION_ID,
      actor: ACTOR,
      action: 'credential.revoked',
      resourceType: 'agent_credential',
      resourceId: CREDENTIAL_ID,
      before: { revokedAt: null },
      after: {
        revokedAt: revokedAt.toISOString(),
        name: 'CI deploy',
        issuedVia: 'API_KEY',
        clientId: null,
      },
    });
    expect(JSON.stringify(audit.record.mock.calls[0][1])).not.toContain('deadbeef');
  });

  it('records nothing for a credential that was already revoked, or is not found', async () => {
    const { service, credentials, audit } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow({ revokedAt: new Date() }));
    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR);

    credentials.findOneBy.mockResolvedValue(null);
    await service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR).catch(() => undefined);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('fails the revoke when the audit entry cannot be recorded', async () => {
    const { service, credentials, audit } = buildHarness();
    credentials.findOneBy.mockResolvedValue(credentialRow());
    audit.record.mockRejectedValue(new Error('audit down'));

    await expect(service.revoke(ORGANIZATION_ID, AGENT_ID, CREDENTIAL_ID, ACTOR)).rejects.toThrow(
      'audit down',
    );
  });
});
