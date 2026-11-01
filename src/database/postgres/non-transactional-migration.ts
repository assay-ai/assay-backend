import { QueryRunner } from 'typeorm';

/**
 * Runs one step of a NON-transactional migration (`transaction = false`:
 * `CREATE INDEX CONCURRENTLY`, `VALIDATE CONSTRAINT` on `payment_intents`)
 * safely (final review 2026-11-01 ops F6):
 *
 * - **Timeouts.** `lock_timeout` 60 s: a concurrent build waits for every
 *   older snapshot, and one idle-in-transaction session would otherwise hang
 *   `migrate` (and the deploy) forever; it now fails, leaving at most an
 *   INVALID index that the migration drops and rebuilds on the next run.
 *   `statement_timeout` 1 h bounds the build itself. Session level (these
 *   steps run outside a transaction, where `SET LOCAL` does nothing), reset
 *   afterwards so later migrations of the run keep their own settings.
 * - **One run at a time.** A session advisory lock keyed by the migration:
 *   a second `migrate` started while the first still builds (a retried
 *   deploy) refuses at once instead of dropping the first one's temporary
 *   index under it. TypeORM itself takes no lock around `migration:run`.
 *
 * Lives outside `migrations/` (every file there is loaded as a migration).
 */
export async function nonTransactionalStep(
  queryRunner: QueryRunner,
  migration: string,
  work: () => Promise<void>,
): Promise<void> {
  const key = `assay-migration:${migration}`;
  const [row] = (await queryRunner.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS "locked"`, [
    key,
  ])) as { locked: boolean }[];
  if (!row?.locked) {
    throw new Error(
      `${migration}: another migration run holds it (a concurrent migrate); retry once it ends`,
    );
  }
  try {
    await queryRunner.query(`SET lock_timeout = '60s'`);
    await queryRunner.query(`SET statement_timeout = '1h'`);
    await work();
  } finally {
    await queryRunner.query(`RESET lock_timeout`).catch(() => undefined);
    await queryRunner.query(`RESET statement_timeout`).catch(() => undefined);
    await queryRunner
      .query(`SELECT pg_advisory_unlock(hashtext($1))`, [key])
      .catch(() => undefined);
  }
}
