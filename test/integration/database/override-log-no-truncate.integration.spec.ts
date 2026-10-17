import { join } from 'path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

/**
 * `override_log_entries` refuses TRUNCATE, like `ledger_entries` (review M-6).
 *
 * A row-level trigger never fires for TRUNCATE, so before
 * `1759700000000-override-log-no-truncate` one statement emptied the log.
 */
describe('override_log_entries refuses TRUNCATE', () => {
  const DATABASE = 'x402_override_log_truncate_test';

  let dataSource: DataSource;

  beforeAll(async () => {
    await dropDatabase(DATABASE);
    await ensureTestDatabase(DATABASE);

    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database: DATABASE,
      entities: [],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'each' });
  }, 300_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await dropDatabase(DATABASE);
  });

  it('refuses TRUNCATE of the log itself', async () => {
    await expect(dataSource.query('TRUNCATE "override_log_entries"')).rejects.toThrow(
      /append-only: TRUNCATE is refused/,
    );
  });

  it('refuses TRUNCATE ... CASCADE through operators', async () => {
    await expect(dataSource.query('TRUNCATE "operators" CASCADE')).rejects.toThrow(
      /append-only: TRUNCATE is refused/,
    );
  });

  it('is scoped to this table, beside the row trigger (control)', async () => {
    await expect(dataSource.query('TRUNCATE "evm_gas_grants"')).resolves.toBeDefined();
    const triggers = await dataSource.query(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = '"override_log_entries"'::regclass AND NOT tgisinternal
        ORDER BY tgname`,
    );
    expect(triggers.map((row: { tgname: string }) => row.tgname)).toEqual([
      'trg_override_log_entries_append_only',
      'trg_override_log_entries_no_truncate',
    ]);
  });
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
