/**
 * Drops every integration test database, so the next `yarn test:integration`
 * builds each one from migration zero.
 *
 * ## Why this has to exist
 *
 * The integration contexts call `ensureTestDatabase` (create-if-absent) and
 * then `runMigrations` (apply-what-is-pending). Neither drops, and neither
 * reverts. That is fine while every migration is additive: a database carried
 * forward from an older commit simply gains the new columns on the next run.
 *
 * `1759300000002-drop-provider-payout-columns` is this branch's first
 * **destructive** migration, and it makes the arrangement one-way. Once any run
 * has taken `app_binding_test` to `…002`, checking out an earlier commit —
 * bisecting, reviewing, or simply working on a branch that predates it — leaves
 * `ProviderEntity` mapping three columns the database no longer has, and every
 * suite in that context dies with:
 *
 * ```
 * QueryFailedError: column ProviderEntity.payout_account_id does not exist
 * ```
 *
 * which names a column, not a cause, and points at the reader's own change
 * rather than at a leftover database. Measured: `binding-publish`,
 * `binding-pause` and `binding-pause-latency` all fail this way
 * on a machine where `…002` has been run once.
 *
 * ## Usage
 *
 * ```sh
 * yarn test:integration:reset      # then yarn test:integration
 * ```
 *
 * Reads the same `DATABASE_*` variables the contexts do, and the same
 * `*_TEST_DATABASE` overrides, so it drops exactly what they would create. It
 * never touches `DATABASE_NAME` itself — the development database is not in the
 * list and is refused explicitly below, because "drop the test databases" and
 * "drop my data" are one typo apart.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv();

const base = process.env.DATABASE_NAME || 'app';

/**
 * Every database an integration context can open, with its override.
 *
 * Kept as one list rather than derived, because the contexts spell their own
 * names inline and a clever derivation would silently stop covering a context
 * that renamed itself. If a context is added and not listed here, the reset is
 * incomplete — and the symptom is the one this script exists to remove, so the
 * list is worth keeping honest by hand.
 */
const DATABASES: readonly string[] = [
  process.env.BINDING_TEST_DATABASE || `${base}_binding_test`,
  process.env.DEPOSIT_TEST_DATABASE || `${base}_deposit_test`,
  process.env.ESCROW_SEQ_TEST_DATABASE || `${base}_escrow_seq_test`,
  process.env.EVIDENCE_TEST_DATABASE || `${base}_evidence_test`,
  process.env.JUDGE_PATH_TEST_DATABASE || `${base}_judge_path_test`,
  process.env.LEDGER_TEST_DATABASE || `${base}_ledger_test`,
  process.env.PAYMENT_TEST_DATABASE || `${base}_payment_test`,
  process.env.PROVIDER_PAYOUT_TEST_DATABASE || `${base}_provider_payout_test`,
  process.env.SETTLEMENT_TEST_DATABASE || `${base}_settlement_test`,
  process.env.WITHHELD_TEST_DATABASE || `${base}_withheld_test`,
  // `verification-test-context.ts` hardcodes this one and takes no override.
  'x402_verification_test',
];

async function main(): Promise<void> {
  const admin = new Client({
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    database: 'postgres',
  });

  await admin.connect();
  try {
    for (const database of DATABASES) {
      // The one guard that matters. Every name above is derived from
      // `DATABASE_NAME` by suffix, so an empty or mis-set variable is the only
      // way the development database could appear in the list — and dropping it
      // is not recoverable.
      if (database === base || database === 'postgres') {
        throw new Error(
          `refusing to drop "${database}": it is the development database (DATABASE_NAME), not a ` +
            `test one. Check DATABASE_NAME and the *_TEST_DATABASE overrides.`,
        );
      }

      // `WITH (FORCE)` (Postgres 13+) evicts sessions a crashed run left open;
      // without it a single stale connection makes the drop hang and the reset
      // is exactly as unusable as the state it is fixing.
      await admin.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}" WITH (FORCE)`);
      // eslint-disable-next-line no-console
      console.log(`dropped ${database}`);
    }
  } finally {
    await admin.end();
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n${DATABASES.length} integration test database(s) dropped. The next ` +
      `\`yarn test:integration\` recreates each one and runs its context's migrations from zero.`,
  );
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
