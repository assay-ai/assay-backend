import { MigrationInterface, QueryRunner } from 'typeorm';

const INDEX = 'idx_payment_intents_paid_held_created';

/**
 * The index behind the public Explorer's "not charged" feed.
 *
 * `PaymentIntentRepository.findNotChargedCandidates` and `summarizeNotCharged`
 * scan a 30-day slice of `payment_intents` **across every tenant**, filtered
 * on `call_class = 'PAID' AND hold_id IS NOT NULL` and a `created_at` range,
 * and the candidates are read newest first. None of the existing indexes leads
 * with `created_at` without a tenant or provider in front of it, so without
 * this both queries are a sequential scan of the whole table.
 *
 * Partial on exactly the two fixed predicates every one of those queries
 * carries, so the index holds only paid calls that reserved funds — free,
 * test and never-secured intents add nothing to it.
 *
 * ## Built `CONCURRENTLY`, outside a transaction
 *
 * A plain `CREATE INDEX` blocks every write to `payment_intents` — every paid
 * call — while it builds. `CREATE INDEX CONCURRENTLY` does not, but Postgres
 * refuses it inside a transaction, so this migration sets `transaction =
 * false` and runs on its own even under `migrationsTransactionMode: 'each'`.
 * (A runner in `'all'` mode refuses any per-migration override; run it with
 * `'each'`, as `postgres.data-source.ts` does.)
 *
 * `IF NOT EXISTS` lets an operator build the index by hand ahead of the deploy
 * with the same statement. A concurrent build that failed half way leaves an
 * INVALID index behind, which `IF NOT EXISTS` would happily skip, so an
 * invalid one is dropped first and rebuilt.
 *
 * Class name and timestamp are unchanged: a database that already ran the
 * earlier, blocking version records it by name and skips this one.
 * See `docs/runbooks/buyer-debt-deploy.md` §2 and §3.
 */
export class PublicExplorerIndex1760400000000 implements MigrationInterface {
  name = 'PublicExplorerIndex1760400000000';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const invalid = (await queryRunner.query(
      `SELECT 1 FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1 AND n.nspname = current_schema() AND NOT i.indisvalid`,
      [INDEX],
    )) as unknown[];
    if (invalid.length > 0) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`);
    }
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}" ON "payment_intents" ` +
        `("created_at") WHERE "call_class" = 'PAID' AND "hold_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`);
  }
}
