import { MigrationInterface, QueryRunner } from 'typeorm';

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
 * Not `CONCURRENTLY`: migrations run inside a transaction here
 * (`migrationsTransactionMode: 'each'`), which `CREATE INDEX CONCURRENTLY`
 * refuses — the convention every other index migration in this folder follows.
 */
export class PublicExplorerIndex1760400000000 implements MigrationInterface {
  name = 'PublicExplorerIndex1760400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_paid_held_created" ON "payment_intents" ` +
        `("created_at") WHERE "call_class" = 'PAID' AND "hold_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_paid_held_created"`);
  }
}
