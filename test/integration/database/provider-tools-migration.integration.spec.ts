import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

const DATABASE = 'x402_provider_tools_migration_test';

/**
 * The T4 migration (`1761900000000-provider-tools`) applies, reverts and
 * applies again on a fresh database, and its constraints hold: the provider
 * name caps, review state only on provider tools, LISTED only when approved,
 * removal bookkeeping, TOOL cutoffs and the promotion invites.
 */
describe('provider tools migration: up, down, up', () => {
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
  }, 300_000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  const columns = async () =>
    (
      (await dataSource.query(
        `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
          WHERE table_schema = 'public'
            AND ((table_name = 'tools' AND column_name IN
                   ('review_version', 'approved_version', 'review_content_hash', 'removed_at',
                    'taken_down_at', 'handle_removed_at', 'pending_category',
                    'status_before_removal'))
              OR (table_name = 'tool_versions' AND column_name = 'declared_rules')
              OR (table_name = 'tool_promotion_invites' AND column_name = 'source_tool_id'))
          ORDER BY 1`,
      )) as { c: string }[]
    ).map((row) => row.c);

  const ALL = [
    'tool_promotion_invites.source_tool_id',
    'tool_versions.declared_rules',
    'tools.approved_version',
    'tools.handle_removed_at',
    'tools.pending_category',
    'tools.removed_at',
    'tools.review_content_hash',
    'tools.review_version',
    'tools.status_before_removal',
    'tools.taken_down_at',
  ];

  async function undoThrough(name: string): Promise<void> {
    const later = (await dataSource.query(
      `SELECT name FROM migrations WHERE id >= (SELECT id FROM migrations WHERE name = $1)
        ORDER BY id DESC`,
      [name],
    )) as { name: string }[];
    for (let i = 0; i < later.length; i += 1) {
      await dataSource.undoLastMigration({ transaction: 'each' });
    }
  }

  it('applies, reverts and applies again', async () => {
    await dataSource.runMigrations({ transaction: 'each' });
    expect(await columns()).toEqual(ALL);

    await undoThrough('ProviderTools1761900000000');
    expect(await columns()).toEqual([]);
    const [{ check }] = await dataSource.query(
      `SELECT pg_get_constraintdef(oid) AS check FROM pg_constraint
        WHERE conname = 'chk_moderation_cutoffs_target'`,
    );
    expect(check).not.toMatch(/'TOOL'::/);

    await dataSource.runMigrations({ transaction: 'each' });
    expect(await columns()).toEqual(ALL);
  });

  describe('constraints', () => {
    let org: string;

    beforeAll(async () => {
      org = randomUUID();
    });

    const insertTool = (name: string, extra: Record<string, string | null> = {}) => {
      const fields = {
        kind: 'PROVIDER',
        owner_org_id: org,
        category: 'misc',
        visibility: 'PRIVATE',
        status: 'DRAFT',
        review_status: 'NONE',
        ...extra,
      };
      const keys = Object.keys(fields);
      return dataSource.query(
        `INSERT INTO tools (id, name, ${keys.join(', ')})
         VALUES (gen_random_uuid(), $1, ${keys.map((_, i) => `$${i + 2}`).join(', ')})
         RETURNING id`,
        [name, ...keys.map((key) => (fields as Record<string, string | null>)[key])],
      );
    };

    it('holds the provider name caps: {tool} ≤ 40, the full name ≤ 48, one "__"', async () => {
      await expect(insertTool('acme__search_posts')).resolves.toHaveLength(1);
      // 40 characters of {tool}: fits.
      await expect(insertTool(`acme__${'a'.repeat(40)}`)).resolves.toHaveLength(1);
      // 41: refused.
      await expect(insertTool(`acme__${'b'.repeat(41)}`)).rejects.toThrow(
        /chk_tools_provider_name/,
      );
      // 49 in all: the column itself refuses it.
      await expect(insertTool(`abcdefghijklmnop__${'c'.repeat(31)}`)).rejects.toThrow(
        /too long|chk_tools_provider_name/,
      );
      // A second separator inside {tool}.
      await expect(insertTool('acme__search__posts')).rejects.toThrow(/chk_tools_provider_name/);
      // No handle, or an uppercase one.
      await expect(insertTool('search_posts')).rejects.toThrow(/chk_tools_provider_name/);
      await expect(insertTool('Acme__search')).rejects.toThrow(/chk_tools_provider_name/);
      // The meta tool names stay reserved.
      await expect(
        dataSource.query(
          `INSERT INTO tools (id, name, kind, category, visibility, status)
           VALUES (gen_random_uuid(), 'call_tool', 'STANDARD', 'misc', 'LISTED', 'ACTIVE')`,
        ),
      ).rejects.toThrow(/chk_tools_name_not_reserved/);
    });

    it('keeps review state on provider tools only, and LISTED only once approved', async () => {
      await expect(insertTool('acme__no_review', { review_status: null })).rejects.toThrow(
        /chk_tools_review_kind/,
      );
      await expect(
        dataSource.query(
          `INSERT INTO tools (id, name, kind, category, visibility, status, review_status)
           VALUES (gen_random_uuid(), 'get_reviewed', 'STANDARD', 'misc', 'LISTED', 'ACTIVE', 'NONE')`,
        ),
      ).rejects.toThrow(/chk_tools_review_kind/);
      await expect(
        insertTool('acme__listed_unapproved', { visibility: 'LISTED', status: 'ACTIVE' }),
      ).rejects.toThrow(/chk_tools_listed_approved/);
      await expect(insertTool('acme__pending', { review_status: 'PENDING' })).rejects.toThrow(
        /chk_tools_review_pending/,
      );
    });

    it('records a removal only with REMOVED, and accepts TOOL cutoffs', async () => {
      const [{ id }] = await insertTool('acme__removable', { status: 'ACTIVE' });
      await expect(
        dataSource.query(
          `UPDATE tools SET removed_at = now(), taken_down_at = now() WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/chk_tools_removal/);
      await dataSource.query(
        `UPDATE tools SET status = 'REMOVED', removed_at = now(), handle_removed_at = now(),
                          status_before_removal = 'ACTIVE' WHERE id = $1`,
        [id],
      );
      await expect(
        dataSource.query(
          `INSERT INTO moderation_cutoffs (target_type, target_id, action, acted_by, confirm_by, note)
           VALUES ('TOOL', $1, 'TAKEDOWN', gen_random_uuid(), now() + interval '72 hours', 'abuse')`,
          [id],
        ),
      ).resolves.toBeDefined();
    });

    it('declared rules are a list, and an invite names two different tools', async () => {
      const [{ id }] = await insertTool('acme__with_rules');
      await expect(
        dataSource.query(
          `INSERT INTO tool_versions (tool_id, version, semver, major, summary, description,
                                      input_schema, output_schema, status, declared_rules)
           VALUES ($1, 1, '1.0.0', 1, 's', 'd', '{}', '{}', 'DRAFT', '{"a":1}')`,
          [id],
        ),
      ).rejects.toThrow(/chk_tool_versions_declared_rules/);
      await expect(
        dataSource.query(
          `INSERT INTO tool_promotion_invites (standard_tool_id, source_tool_id, organization_id,
                                               invited_by)
           VALUES ($1, $1, $2, gen_random_uuid())`,
          [id, org],
        ),
      ).rejects.toThrow(/chk_tool_promotion_invites_distinct/);
    });
  });
});
