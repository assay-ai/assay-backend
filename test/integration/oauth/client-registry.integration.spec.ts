import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { OAuthAccessTokenEntity } from '@database/postgres/entities/oauth-access-token.entity';
import { OAuthAuthorizationCodeEntity } from '@database/postgres/entities/oauth-authorization-code.entity';
import {
  OAuthClientEntity,
  OAuthClientKind,
} from '@database/postgres/entities/oauth-client.entity';
import { OAuthRefreshTokenEntity } from '@database/postgres/entities/oauth-refresh-token.entity';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { CimdFetcher } from '@modules/oauth/services/cimd.fetcher';
import { DcrService } from '@modules/oauth/services/dcr.service';
import { OAuthClientRegistry } from '@modules/oauth/services/oauth-client.registry';
import { EgressHttpClient } from '@shared/network/egress';

import { FakeEgressHttpClient } from '../../unit/auth/helpers/fake-egress';
import {
  Clock,
  FakeOAuthRedis,
  MCP,
  fakeCache,
  oauthConfig,
  oauthMetrics,
  rateLimiter,
} from '../../unit/oauth/helpers/oauth-fakes';
import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

/**
 * The client registry against the real `oauth_clients` table: the boot upsert
 * of the built-in row is idempotent, a re-fetched CIMD document updates its
 * row in place (same id, so credentials stay attached), and a DCR
 * registration is a plain insert that resolves afterwards.
 */
describe('OAuth client registry — real Postgres', () => {
  const DATABASE = 'assay_oauth_clients_test';
  const CIMD_URL = 'https://tools.example.com/client.json';
  const IP = '203.0.113.7';

  let dataSource: DataSource;
  let clients: OAuthClientRepository;

  beforeAll(async () => {
    await dropDatabase(DATABASE);
    await ensureTestDatabase(DATABASE);
    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database: DATABASE,
      entities: [
        AgentCredentialEntity,
        OAuthClientEntity,
        OAuthAuthorizationCodeEntity,
        OAuthRefreshTokenEntity,
        OAuthAccessTokenEntity,
      ],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'each' });
    clients = new OAuthClientRepository(dataSource);
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  function setup(name: { value: string }) {
    const config = oauthConfig();
    const clock = new Clock();
    const redis = new FakeOAuthRedis();
    const { metrics } = oauthMetrics();
    const egress = new FakeEgressHttpClient().respondWith((request) => {
      const body = JSON.stringify({
        client_id: request.url,
        client_name: name.value,
        redirect_uris: ['http://127.0.0.1/callback'],
      });
      return { status: 200, headers: {}, body, bytes: body.length, url: request.url, redirects: 0 };
    });
    const limiter = rateLimiter(redis, clock);
    const fetcher = new CimdFetcher(
      egress as unknown as EgressHttpClient,
      clients,
      limiter,
      fakeCache(redis),
      metrics,
      config,
      clock.now,
    );
    const registry = new OAuthClientRegistry(clients, fetcher, config);
    const dcr = new DcrService(clients, limiter, config, clock.now);
    return { registry, dcr, clock, egress };
  }

  it('upserts the built-in row once, however often the server boots', async () => {
    const { registry } = setup({ value: 'unused' });
    await registry.onModuleInit();
    const first = await clients.findByClientId(`${MCP}/oauth/clients/assay-mcp`);
    await registry.onModuleInit();
    const rows = await clients.find({ where: { kind: OAuthClientKind.BUILTIN } });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first!.id);
    expect(rows[0].clientName).toBe('Assay app (assay-mcp)');
    expect(rows[0].redirectUris).toEqual(['http://127.0.0.1/callback']);
  });

  it('a re-fetched CIMD document updates its row in place', async () => {
    const name = { value: 'Example Tools' };
    const { registry, clock, egress } = setup(name);

    const first = await registry.resolve(CIMD_URL, IP);
    expect(first).toMatchObject({ kind: OAuthClientKind.CIMD, name: 'Example Tools' });
    const stored = (await clients.findByClientId(CIMD_URL))!;
    expect(stored.fetchedAt).toBeInstanceOf(Date);
    expect(stored.cacheUntil!.getTime() - stored.fetchedAt!.getTime()).toBe(3600_000);

    name.value = 'Example Tools 2';
    clock.advance(3601);
    const second = await registry.resolve(CIMD_URL, IP);
    expect(second).toMatchObject({ name: 'Example Tools 2' });
    expect(egress.requests).toHaveLength(2);

    const updated = (await clients.findByClientId(CIMD_URL))!;
    expect(updated.id).toBe(stored.id);
    expect(updated.createdAt.getTime()).toBe(stored.createdAt.getTime());
    expect(updated.cacheUntil!.getTime()).toBeGreaterThan(stored.cacheUntil!.getTime());
    expect(await clients.count({ where: { clientId: CIMD_URL } })).toBe(1);
  });

  it('a DCR registration is stored and then resolves', async () => {
    const { registry, dcr } = setup({ value: 'unused' });
    const result = await dcr.register(
      {
        client_name: 'Code Editor',
        redirect_uris: ['http://127.0.0.1/', 'http://localhost:33418/cb'],
      },
      IP,
    );
    expect(result.ok).toBe(true);
    if (result.ok === false) return;

    const row = (await clients.findByClientId(result.body.client_id))!;
    expect(row.kind).toBe(OAuthClientKind.DCR);
    expect(row.metadata).toMatchObject({
      client_id: result.body.client_id,
      client_name: 'Code Editor',
      token_endpoint_auth_method: 'none',
    });
    expect(await registry.resolve(result.body.client_id, IP)).toMatchObject({
      id: row.id,
      kind: OAuthClientKind.DCR,
      name: 'Code Editor',
    });
  });

  it('an upsert never changes the kind of an existing row', async () => {
    const dcrId = 'dcr_' + 'k'.repeat(22);
    const inserted = await clients.insertClient({
      clientId: dcrId,
      kind: OAuthClientKind.DCR,
      clientName: 'Registered',
      clientUri: null,
      redirectUris: ['http://127.0.0.1/cb'],
      metadata: {},
      fetchedAt: null,
      cacheUntil: null,
    });
    const result = await clients.upsertByClientId({
      clientId: dcrId,
      kind: OAuthClientKind.CIMD,
      clientName: 'Hijack',
      clientUri: null,
      redirectUris: ['http://127.0.0.1/evil'],
      metadata: {},
      fetchedAt: new Date(),
      cacheUntil: new Date(),
    });
    expect(result).toBeNull();
    const row = (await clients.findByClientId(dcrId))!;
    expect(row).toMatchObject({
      id: inserted.id,
      kind: OAuthClientKind.DCR,
      clientName: 'Registered',
    });
    expect(row.redirectUris).toEqual(['http://127.0.0.1/cb']);
  });

  async function dropDatabase(database: string): Promise<void> {
    const connection = testConnectionOptions();
    const admin = new Client({
      host: connection.host,
      port: connection.port,
      user: connection.username,
      password: connection.password,
      database: 'postgres',
    });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
});
