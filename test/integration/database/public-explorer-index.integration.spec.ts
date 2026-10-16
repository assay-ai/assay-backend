import { DataSource } from 'typeorm';

import { PublicExplorerIndex1760400000000 } from '@database/postgres/migrations/1760400000000-public-explorer-index';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

const INDEX = 'idx_payment_intents_paid_held_created';

/**
 * The Explorer index is built `CONCURRENTLY` outside a transaction, so it does
 * not block writes to `payment_intents` on a live database (audit 2026-10-17
 * P3-4). Run against its own scratch database with a minimal table: the point
 * is the DDL, not the payment schema.
 */
describe('PublicExplorerIndex1760400000000', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    const database = await ensureTestDatabase('assay_explorer_index_test');
    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database,
      synchronize: false,
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(`DROP TABLE IF EXISTS payment_intents`);
    await dataSource.query(
      `CREATE TABLE payment_intents (
         id serial PRIMARY KEY,
         call_class varchar(16) NOT NULL,
         hold_id uuid NULL,
         created_at timestamptz NOT NULL DEFAULT now())`,
    );
  });

  async function indexState(): Promise<{ valid: boolean; def: string } | null> {
    const rows = (await dataSource.query(
      `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1`,
      [INDEX],
    )) as { valid: boolean; def: string }[];
    return rows[0] ?? null;
  }

  async function run(direction: 'up' | 'down'): Promise<void> {
    const runner = dataSource.createQueryRunner();
    try {
      await new PublicExplorerIndex1760400000000()[direction](runner);
    } finally {
      await runner.release();
    }
  }

  it('opts out of the migration transaction', () => {
    expect(new PublicExplorerIndex1760400000000().transaction).toBe(false);
  });

  it('builds the partial index, is idempotent, and drops it on down', async () => {
    await run('up');
    const state = await indexState();
    expect(state?.valid).toBe(true);
    expect(state?.def).toMatch(/\(created_at\) WHERE/);
    expect(state?.def).toMatch(/call_class\)::text = 'PAID'/);
    expect(state?.def).toMatch(/hold_id IS NOT NULL/);

    // Already built (by hand, or a re-run): a no-op, not an error.
    await run('up');
    expect((await indexState())?.valid).toBe(true);

    await run('down');
    expect(await indexState()).toBeNull();
  });

  it('rebuilds an INVALID index left by a failed concurrent build', async () => {
    await dataSource.query(`CREATE INDEX "${INDEX}" ON payment_intents (created_at)`);
    await dataSource.query(
      `UPDATE pg_index SET indisvalid = false
        WHERE indexrelid = (SELECT oid FROM pg_class WHERE relname = $1)`,
      [INDEX],
    );
    expect((await indexState())?.valid).toBe(false);

    await run('up');

    const state = await indexState();
    expect(state?.valid).toBe(true);
    expect(state?.def).toMatch(/WHERE/);
  });
});
