import { MigrationInterface, QueryRunner } from 'typeorm';

const INDEXES = [
  {
    name: 'idx_payment_intents_delegate_created',
    columns: '("voucher_delegate", "created_at")',
  },
  { name: 'idx_payment_intents_delegate_recent', columns: '("created_at")' },
] as const;

const PREDICATE = `"voucher_delegate" IS NOT NULL`;

/**
 * Two partial indexes over the delegate-signed rail-B vouchers, for the
 * payment-key notifications (spec §7.10 item 6):
 *
 * - `idx_payment_intents_delegate_created` (`voucher_delegate`, `created_at`):
 *   "has this key spent before?", asked after each delegate-signed voucher is
 *   admitted (`PaymentKeyFirstSpendService`).
 * - `idx_payment_intents_delegate_recent` (`created_at`): the daily summary's
 *   one cross-tenant pass over yesterday's delegate-signed vouchers.
 *
 * Both are partial on `voucher_delegate IS NOT NULL`, so rail A and
 * payer-signed vouchers cost them nothing.
 *
 * ## Built `CONCURRENTLY`, outside a transaction
 *
 * Same reasoning as `1761000000000-idempotency-key-live-intents.ts`: a plain
 * `CREATE INDEX` blocks every write to `payment_intents` — every paid call —
 * for the length of the build. A concurrent build that failed half way leaves
 * an INVALID index behind; a rerun drops it and builds it again, and finds a
 * valid one already in place.
 */
export class PaymentKeySpendIndexes1762400000020 implements MigrationInterface {
  name = 'PaymentKeySpendIndexes1762400000020';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const index of INDEXES) {
      if ((await exists(queryRunner, index.name)) && !(await isValid(queryRunner, index.name))) {
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
      }
      await queryRunner.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index.name}" ON "payment_intents" ` +
          `${index.columns} WHERE ${PREDICATE}`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const index of [...INDEXES].reverse()) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
    }
  }
}

async function exists(queryRunner: QueryRunner, name: string): Promise<boolean> {
  const rows = (await queryRunner.query(
    `SELECT 1 FROM pg_indexes WHERE indexname = $1 AND schemaname = current_schema()`,
    [name],
  )) as unknown[];
  return rows.length > 0;
}

async function isValid(queryRunner: QueryRunner, name: string): Promise<boolean> {
  const rows = (await queryRunner.query(
    `SELECT i.indisvalid AS valid FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1 AND n.nspname = current_schema()`,
    [name],
  )) as Array<{ valid: boolean }>;
  return rows[0]?.valid === true;
}
