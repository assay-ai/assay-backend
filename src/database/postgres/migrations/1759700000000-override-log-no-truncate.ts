import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Refuses `TRUNCATE` on `override_log_entries` (security review M-6).
 *
 * The row trigger from `1757700000000` refuses UPDATE and DELETE, but a
 * row-level trigger never fires for TRUNCATE, so one statement could empty the
 * log. This adds the statement-level trigger the ledger already has
 * (`trg_ledger_entries_no_truncate`, `1755100000000`), reusing the same
 * function as the row trigger.
 *
 * A `TRUNCATE operators CASCADE` now fails too, because this table references
 * `operators`. That is intended.
 *
 * It still does not stop a role that owns the table from disabling the
 * trigger; that needs the app to run under a role that does not own it.
 */
export class OverrideLogNoTruncate1759700000000 implements MigrationInterface {
  name = 'OverrideLogNoTruncate1759700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TRIGGER "trg_override_log_entries_no_truncate"
      BEFORE TRUNCATE ON "override_log_entries"
      FOR EACH STATEMENT EXECUTE FUNCTION "override_log_entries_append_only"()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_override_log_entries_no_truncate" ON "override_log_entries"`,
    );
  }
}
