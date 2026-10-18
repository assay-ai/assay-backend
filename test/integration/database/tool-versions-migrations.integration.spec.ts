import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

const DATABASE = 'x402_tool_versions_migrations_test';

/**
 * The T3 contract migrations (`tool_versions`, binding contract terms) apply,
 * revert and apply again on a fresh database, and the constraints hold.
 */
describe('tool version migrations: up, down, up', () => {
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

  const columns = async () =>
    (
      (await dataSource.query(
        `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
          WHERE table_schema = 'public'
            AND ((table_name = 'tool_versions' AND column_name = 'semver')
              OR (table_name = 'tools' AND column_name IN ('current_version', 'replacement_tool_id'))
              OR (table_name IN ('tool_bindings', 'binding_versions')
                  AND column_name IN ('tool_version_range', 'provides_output_fields'))
              OR (table_name = 'binding_test_runs' AND column_name = 'tool_version')
              OR (table_name = 'tool_requests' AND column_name = 'tool_id')
              OR (table_name = 'tools' AND column_name = 'last_version_number')
              OR (table_name = 'tool_versions' AND column_name = 'edited_by'))
          ORDER BY 1`,
      )) as { c: string }[]
    ).map((row) => row.c);

  const ALL = [
    'binding_test_runs.tool_version',
    'binding_versions.provides_output_fields',
    'binding_versions.tool_version_range',
    'tool_bindings.provides_output_fields',
    'tool_bindings.tool_version_range',
    'tool_requests.tool_id',
    'tool_versions.edited_by',
    'tool_versions.semver',
    'tools.current_version',
    'tools.last_version_number',
    'tools.replacement_tool_id',
  ];

  /** Migrations after the T3 ones, newest first. */
  const LATER = [
    'CreateVaultKekChecks1762000000003',
    'ToolBindingAuthMode1762000000002',
    'CreateBindingCredentials1762000000001',
    'DropConnectivityEgressIps1762000000000',
    'CallDisputes1761800000002',
    'VerificationRecordDisputeOutcome1761800000001',
    'PaymentIntentDisputeHold1761800000000',
  ];

  it('applies, reverts the three T3 migrations, and applies them again', async () => {
    await dataSource.runMigrations({ transaction: 'each' });
    expect(await columns()).toEqual(ALL);
    // Later migrations sit on top of these and touch none of their objects.
    for (const name of LATER) {
      const [last] = (await dataSource.query(
        `SELECT name FROM migrations ORDER BY id DESC LIMIT 1`,
      )) as { name: string }[];
      expect(last.name).toBe(name);
      await dataSource.undoLastMigration({ transaction: 'each' });
    }

    const applied = (await dataSource.query(
      `SELECT name FROM migrations WHERE name IN ('BindingContractTerms1761500000001', 'ToolDraftIntegrity1761600000000', 'ToolVersions1761500000000')`,
    )) as { name: string }[];
    expect(applied.map((row) => row.name).sort()).toEqual([
      'BindingContractTerms1761500000001',
      'ToolDraftIntegrity1761600000000',
      'ToolVersions1761500000000',
    ]);

    // Back to before ToolVersions, however many migrations came after it.
    for (;;) {
      const [last] = (await dataSource.query(
        `SELECT name FROM migrations ORDER BY timestamp DESC, id DESC LIMIT 1`,
      )) as { name: string }[];
      await dataSource.undoLastMigration({ transaction: 'each' });
      if (last?.name === 'ToolVersions1761500000000') break;
    }
    expect(await columns()).toEqual([]);

    await dataSource.runMigrations({ transaction: 'each' });
    expect(await columns()).toEqual(ALL);
  });

  it('holds the version state machine and the range format', async () => {
    const [tool] = await dataSource.query(
      `INSERT INTO tools (id, name, kind, category, visibility, status)
       VALUES (gen_random_uuid(), 'get_example', 'STANDARD', 'misc', 'LISTED', 'DRAFT')
       RETURNING id`,
    );
    const insert = (version: number, semver: string, status: string, extra = '') =>
      dataSource.query(
        `INSERT INTO tool_versions (tool_id, version, semver, major, summary, description,
                                    input_schema, output_schema, status, published_at, sunset_at)
         VALUES ($1, $2, $3::varchar, split_part($3::varchar, '.', 1)::int, 's', 'd', '{}', '{}', $4, ${
           status === 'DRAFT' ? 'NULL' : 'now()'
         }, ${extra || 'NULL'})`,
        [tool.id, version, semver, status],
      );

    await insert(1, '1.0.0', 'ACTIVE');
    await insert(2, '1.1.0', 'DRAFT');
    // One draft per tool.
    await expect(insert(3, '1.2.0', 'DRAFT')).rejects.toThrow(/uq_tool_versions_one_draft/);
    // A deprecated version names its sunset.
    await expect(insert(3, '1.2.0', 'DEPRECATED')).rejects.toThrow(/chk_tool_versions_sunset/);
    // semver is three numbers and unique per tool.
    await expect(insert(3, '1.2', 'ACTIVE')).rejects.toThrow(/chk_tool_versions_semver/);
    await expect(insert(3, '1.0.0', 'ACTIVE')).rejects.toThrow(/uq_tool_versions_semver/);

    await dataSource.query(
      `UPDATE tools SET current_version = 1, status = 'ACTIVE' WHERE id = $1`,
      [tool.id],
    );
    await expect(
      dataSource.query(`UPDATE tools SET current_version = 9 WHERE id = $1`, [tool.id]),
    ).rejects.toThrow(/fk_tools_current_version/);
  });
});
