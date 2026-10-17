import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

const DATABASE = 'x402_toolset_publishing_migrations_test';

/** The T2 publishing migrations apply, revert and apply again on a fresh database. */
describe('toolset publishing migrations: up, down, up', () => {
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
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  const tables = async () =>
    (
      (await dataSource.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('toolset_versions', 'org_handle_history', 'moderation_cutoffs')
          ORDER BY table_name`,
      )) as { table_name: string }[]
    ).map((row) => row.table_name);

  it('applies, reverts the two T2 publishing migrations, and applies them again', async () => {
    await dataSource.runMigrations({ transaction: 'each' });
    expect(await tables()).toEqual([
      'moderation_cutoffs',
      'org_handle_history',
      'toolset_versions',
    ]);

    // Undo everything newer than the two T2 migrations first (T3 came later),
    // then the two themselves.
    const t2 = ['OrgHandles1761400000000', 'ToolsetPublishing1761400000001'];
    let undone: string[] = [];
    while (!t2.every((name) => undone.includes(name))) {
      const [last] = (await dataSource.query(
        `SELECT name FROM migrations ORDER BY id DESC LIMIT 1`,
      )) as { name: string }[];
      await dataSource.undoLastMigration({ transaction: 'each' });
      undone = [...undone, last.name];
    }
    expect(await tables()).toEqual([]);

    await dataSource.runMigrations({ transaction: 'each' });
    expect(await tables()).toEqual([
      'moderation_cutoffs',
      'org_handle_history',
      'toolset_versions',
    ]);
  });

  it('refuses to change a published version', async () => {
    const [org] = await dataSource.query(
      `INSERT INTO organizations (name, created_via) VALUES ('Example', 'TEST') RETURNING id`,
    );
    const [toolset] = await dataSource.query(
      `INSERT INTO toolsets (owner_org_id, publisher_kind, slug, name)
       VALUES ($1, 'USER', 'kit', 'Kit') RETURNING id`,
      [org.id],
    );
    await dataSource.query(
      `INSERT INTO toolset_versions (toolset_id, version, entries, tool_ids, discovery,
                                     search_threshold, pinned_tools, name, shared_as)
       VALUES ($1, 1, '[]', '{}', 'AUTO', 25, '{}', 'Kit', 'PUBLIC')`,
      [toolset.id],
    );
    await expect(
      dataSource.query(`UPDATE toolset_versions SET name = 'Other' WHERE toolset_id = $1`, [
        toolset.id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      dataSource.query(`DELETE FROM toolset_versions WHERE toolset_id = $1`, [toolset.id]),
    ).rejects.toThrow(/immutable/);
  });
});
