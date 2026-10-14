import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adoptConfigPersonIdentity } from '../../../scripts/devnet/lib/acceptance-identity';

/**
 * Review N-2: provider writes refuse an agent session, so the devnet
 * acceptance suite speaks as the provider through a config-file record marked
 * `"kind": "human"` instead of a minted agent credential.
 */
describe('adoptConfigPersonIdentity', () => {
  const ENV = 'ACCEPTANCE_TEST_PERSON_TOKEN';
  const PERSON = 'person-token-for-the-acceptance-spec';
  const MACHINE = 'machine-token-for-the-acceptance-spec';
  const RECORD = {
    credentialId: 'cred-acceptance-provider',
    organizationId: '11111111-1111-4111-8111-111111111111',
    agentId: '22222222-2222-4222-8222-222222222222',
    agentAccount: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:AcceptanceProviderWallet111111',
    chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  };
  const saved = { ...process.env };

  function appWith(providers: unknown[]) {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FROM providers')) return providers;
      if (sql.includes('FROM agents')) return [{ organization_id: RECORD.organizationId }];
      return [];
    });
    return { app: { get: () => ({ query }) } as never, query };
  }

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'acceptance-person-'));
    const path = join(dir, 'credentials.json');
    writeFileSync(
      path,
      JSON.stringify({ [PERSON]: { ...RECORD, kind: 'human' }, [MACHINE]: RECORD }),
    );
    process.env.MCP_CREDENTIALS_FILE = path;
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('speaks as the record, creating its organization and agent rows when missing', async () => {
    process.env[ENV] = PERSON;
    const { app, query } = appWith([]);

    await expect(adoptConfigPersonIdentity(app, ENV, 'provider')).resolves.toEqual({
      organizationId: RECORD.organizationId,
      agentId: RECORD.agentId,
      token: PERSON,
      accountId: RECORD.agentAccount,
    });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes('INSERT INTO organizations'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO agents'))).toBe(true);
  });

  it('refuses an unset variable', async () => {
    delete process.env[ENV];
    await expect(adoptConfigPersonIdentity(appWith([]).app, ENV, 'provider')).rejects.toThrow(
      new RegExp(`${ENV} is not set`),
    );
  });

  it('refuses a record not marked human, which resolves as an agent', async () => {
    process.env[ENV] = MACHINE;
    await expect(adoptConfigPersonIdentity(appWith([]).app, ENV, 'provider')).rejects.toThrow(
      /not marked "kind": "human"/,
    );
  });

  it('refuses an organization that is already a provider, before writing anything', async () => {
    process.env[ENV] = PERSON;
    const { app, query } = appWith([{ '?column?': 1 }]);

    await expect(adoptConfigPersonIdentity(app, ENV, 'provider')).rejects.toThrow(
      /already a provider/,
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT'))).toBe(false);
  });

  it('never names the token in an error', async () => {
    process.env[ENV] = 'not-a-configured-token-value';
    await expect(adoptConfigPersonIdentity(appWith([]).app, ENV, 'provider')).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('not-a-configured-token-value'),
      }),
    );
  });
});
