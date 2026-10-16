import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `created_at` / `updated_at` / `deleted_at` become `timestamptz`
 * across every table.
 *
 * ## Why this migration exists, and why it is here
 *
 * `AbstractEntity` used TypeORM's bare `@CreateDateColumn`, whose Postgres
 * default is `timestamp WITHOUT time zone`. Every table inherited it, while the
 * *domain* timestamps written by hand (`expires_at`, `hold_released_at`,
 * `evaluated_at`, `settled_at`) were correctly `timestamptz` all along — so the
 * schema disagreed with itself about whether an instant carries an offset.
 *
 * The stored values were never wrong. A UTC database writing `now()` stores UTC
 * wall-clock. The *type* was wrong, and two defects fell out of it, both
 * invisible on a UTC host:
 *
 * 1. node-postgres read the column back as **local** time, so every `createdAt`
 *    the API published was shifted by the host's offset.
 * 2. `created_at >= :from` compared a naive column to an absolute parameter,
 *    which Postgres resolves with the **session** time zone — the same query
 *    over the same rows answered differently depending on where it ran.
 *
 * (2) was patched at a single query earlier and (1) left as open work owed by
 * "whoever next touches `AbstractEntity` or adds a table". The dashboard API
 * adds five tables, so it is owed here — and a new table copying the old
 * convention would have made the problem one table bigger.
 *
 * It is also needed on its own merits. Cursor pagination keys on
 * `created_at`. A cursor that carries a timestamp the driver shifts on the way
 * out and does not shift on the way back in skips or repeats rows at every page
 * boundary, and it does so *quietly* — the page still renders.
 *
 * ## Why `USING ... AT TIME ZONE 'UTC'` and not a bare cast
 *
 * A bare `ALTER COLUMN ... TYPE timestamptz` interprets each existing naive
 * value in the **session** time zone. Run on a connection not in UTC that would
 * rewrite every historical row by the session offset — silently, irreversibly, and
 * across the money tables. `AT TIME ZONE 'UTC'` states what the stored
 * wall-clock actually is, so the migration produces the same instants no matter
 * which host applies it. That property is the whole reason this is written by
 * hand rather than generated.
 *
 * `down()` is the exact inverse (`AT TIME ZONE 'UTC'` on a `timestamptz` yields
 * the UTC wall-clock as a naive value), so a revert restores the previous bytes
 * rather than an approximation of them.
 */
export class TimestamptzTimestamps1755900000000 implements MigrationInterface {
  name = 'TimestamptzTimestamps1755900000000';

  /**
   * Every table carrying `AbstractEntity`'s timestamps at the time of writing.
   *
   * Listed explicitly rather than discovered from `information_schema`, so that
   * the set this migration touched is readable in the diff. A table added later
   * inherits `timestamptz` from the entity base class and needs no entry here.
   */
  private static readonly TABLES = [
    'account_balances',
    'deposit_intents',
    'ledger_entries',
    'ledger_holds',
    'payment_intents',
    'reconciliation_runs',
    'verification_policies',
    'verification_records',
    // `_examples`, behind EXAMPLES_ENABLED. Included so a developer running the
    // examples does not meet a second convention.
    'posts',
  ] as const;

  private static readonly COLUMNS = ['created_at', 'updated_at', 'deleted_at'] as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.convert(queryRunner, 'timestamptz');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.convert(queryRunner, 'timestamp');
  }

  /**
   * Converts in both directions.
   *
   * `to_regclass` skips a table that does not exist in this database — `posts`
   * only exists where the examples ran — and the `information_schema` lookup
   * skips a column a table does not have, since the soft-delete and
   * no-soft-delete entity bases differ by exactly `deleted_at`. Both are
   * checked rather than assumed so that applying this to a partially-migrated
   * database fails on nothing.
   */
  private async convert(queryRunner: QueryRunner, target: 'timestamptz' | 'timestamp') {
    for (const table of TimestamptzTimestamps1755900000000.TABLES) {
      const [{ exists }] = (await queryRunner.query(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [`public.${table}`],
      )) as [{ exists: boolean }];
      if (!exists) continue;

      for (const column of TimestamptzTimestamps1755900000000.COLUMNS) {
        const found = (await queryRunner.query(
          `SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
          [table, column],
        )) as unknown[];
        if (found.length === 0) continue;

        await queryRunner.query(
          `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE ${target} ` +
            `USING "${column}" AT TIME ZONE 'UTC'`,
        );
      }
    }
  }
}
