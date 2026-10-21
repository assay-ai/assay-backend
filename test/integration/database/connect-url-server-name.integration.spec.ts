import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

const DATABASE = 'assay_connect_url_server_name_test';
const AGENT = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-000000000002';

/** `agent_connect_urls.server_name` is varchar(56) with the 8.3.1 pattern; the migration reverts and reapplies. */
describe('connect url server name migration', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    const connection = testConnectionOptions();
    const admin = new Client({
      host: connection.host,
      port: connection.port,
      user: connection.username,
      password: connection.password,
      database: 'postgres',
    });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    await admin.end();
    await ensureTestDatabase(DATABASE);
    dataSource = new DataSource({
      type: 'postgres',
      ...connection,
      database: DATABASE,
      entities: [join(__dirname, '../../../src/database/postgres/entities/*.entity.ts')],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'each' });
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  const width = async (): Promise<number> => {
    const [row] = (await dataSource.query(
      `SELECT character_maximum_length AS n FROM information_schema.columns
        WHERE table_name = 'agent_connect_urls' AND column_name = 'server_name'`,
    )) as { n: number }[];
    return row.n;
  };

  const insert = (name: string, url: string) =>
    dataSource.query(
      `INSERT INTO agent_connect_urls (agent_id, organization_id, canonical_url, server_name)
       VALUES ($1, $2, $3, $4)`,
      [AGENT, ORG, url, name],
    );

  it('stores 56 characters, refuses 57 and underscores', async () => {
    expect(await width()).toBe(56);
    await insert('a'.repeat(56), 'u1');
    await expect(insert('a'.repeat(57), 'u2')).rejects.toThrow();
    await expect(insert('a_b', 'u3')).rejects.toThrow();
  });

  it('reverts to 9 characters and applies again', async () => {
    // Later migrations sit on top of this one and touch none of its objects.
    for (const later of ['PaymentIntentsCreatedIndex1762400000040']) {
      const [top] = (await dataSource.query(
        `SELECT name FROM migrations ORDER BY id DESC LIMIT 1`,
      )) as { name: string }[];
      expect(top.name).toBe(later);
      await dataSource.undoLastMigration({ transaction: 'each' });
    }
    const [last] = (await dataSource.query(
      `SELECT name FROM migrations ORDER BY id DESC LIMIT 1`,
    )) as { name: string }[];
    expect(last.name).toBe('ConnectUrlServerName1762400000030');
    await dataSource.undoLastMigration({ transaction: 'each' });
    expect(await width()).toBe(9);
    const rows = (await dataSource.query(`SELECT server_name FROM agent_connect_urls`)) as {
      server_name: string | null;
    }[];
    expect(rows.every((r) => r.server_name === null)).toBe(true);
    await dataSource.runMigrations({ transaction: 'each' });
    expect(await width()).toBe(56);
  });
});
