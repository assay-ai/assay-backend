import { DataSource } from 'typeorm';

import { PaymentIntentsCreatedIndex1762400000040 } from '@database/postgres/migrations/1762400000040-payment-intents-created-index';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

const INDEX = 'idx_payment_intents_created_at';

/**
 * The operator health tile counts intents by `created_at` across every tenant
 * (`PlatformMetricsRepository.intentRateCounts`). The index is built
 * `CONCURRENTLY` outside a transaction so it never blocks paid calls. Runs
 * against a scratch database with a minimal table: the point is the DDL and
 * that the planner can use it for the tile's range.
 */
describe('PaymentIntentsCreatedIndex1762400000040', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    const database = await ensureTestDatabase('assay_intents_created_index_test');
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
      await new PaymentIntentsCreatedIndex1762400000040()[direction](runner);
    } finally {
      await runner.release();
    }
  }

  it('opts out of the migration transaction', () => {
    expect(new PaymentIntentsCreatedIndex1762400000040().transaction).toBe(false);
  });

  it('builds the index, is idempotent, and drops it on down', async () => {
    await run('up');
    const state = await indexState();
    expect(state?.valid).toBe(true);
    expect(state?.def).toMatch(/USING btree \(created_at\)$/);

    await run('up');
    expect((await indexState())?.valid).toBe(true);

    await run('down');
    expect(await indexState()).toBeNull();
  });

  it("serves the health tile's last-hour range", async () => {
    await dataSource.query(
      `INSERT INTO payment_intents (created_at)
       SELECT now() - (g || ' minutes')::interval FROM generate_series(1, 20000) g`,
    );
    await run('up');
    await dataSource.query(`ANALYZE payment_intents`);
    const plan = (await dataSource.query(
      `EXPLAIN SELECT COUNT(*) FROM payment_intents
        WHERE created_at >= now() - interval '61 minutes' AND created_at < now()`,
    )) as { 'QUERY PLAN': string }[];
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(INDEX);
  });
});
