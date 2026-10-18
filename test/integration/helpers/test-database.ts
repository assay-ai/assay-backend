import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId } from '@modules/chains/ports/caip.types';

export const USDC_ASSET: AssetId = ASSET_IDS.USDC_SOLANA_MAINNET;
export const USDC_DECIMALS = 6;

/**
 * Concurrency tests fire many simultaneous transactions, each of which holds a
 * connection for the whole of its row lock. A default pool of ten would turn a
 * lock-contention test into a connection-queueing test and hide the thing being
 * measured.
 */
export const TEST_POOL_SIZE = 30;

export function testConnectionOptions() {
  return {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
  };
}

/**
 * Creates a test database if it does not exist, and returns its name.
 *
 * A dedicated database rather than the development one: these suites write
 * thousands of journal rows that can never be deleted, and pointing that at
 * `app` would make a developer's local data unusable within a few runs.
 */
export async function ensureTestDatabase(database: string): Promise<string> {
  const connection = testConnectionOptions();

  const admin = new Client({
    host: connection.host,
    port: connection.port,
    user: connection.username,
    password: connection.password,
    database: 'postgres',
  });

  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (existing.rowCount === 0) {
      // Identifier, not a value — it cannot be parameterised, so it is quoted.
      await admin.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }

  return database;
}

/**
 * A stable uuid for a human-readable label.
 *
 * `intent_id`, `agent_id` and friends are `uuid` columns, so a test cannot pass
 * `'intent-release-twice'` directly. Hashing the label keeps the test reading
 * in intents and agents rather than in opaque uuids, while still handing the
 * schema the type it declares. Deterministic on purpose: the same label inside
 * one test is the same entity, which is what the uniqueness indexes are there
 * to police.
 */
export function uuidFromLabel(label: string): string {
  const hash = createHash('sha1').update(label).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

/**
 * The `buyer_escrows` slice of `WidenSignatureAndAccountColumns1759300000000`.
 *
 * That migration also widens columns on `slash_proposals`, `verifier_signing_keys`
 * and `agents`, none of which a payment-only harness creates, so it cannot run
 * here as a whole. `BuyerEscrowEntity` maps the renamed columns, so without this
 * every write to `buyer_escrows` fails on `escrow_account_id` rather than on the
 * thing under test.
 */
export class BuyerEscrowAccountColumnsSlice1759300000000 implements MigrationInterface {
  name = 'BuyerEscrowAccountColumnsSlice1759300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "buyer_escrows" RENAME COLUMN "escrow_pda" TO "escrow_account_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "buyer_escrows" RENAME COLUMN "escrow_token_account" TO "escrow_asset_account_id"`,
    );
    await queryRunner.query(`
      ALTER TABLE "buyer_escrows"
        ALTER COLUMN "escrow_account_id"       TYPE character varying(256),
        ALTER COLUMN "escrow_asset_account_id" TYPE character varying(256)
    `);
  }

  public async down(): Promise<void> {
    // Test databases are dropped, never rolled back.
  }
}

/**
 * Rebuilds the schema of a test database whose migrations changed after it was
 * built. The migrations table records a migration by name, so a migration that
 * is edited in place (or swapped for another branch's version of it) is
 * skipped as "already applied" and the database keeps the old shape. The
 * fingerprint of every migration's source is stored beside the schema; a
 * mismatch drops and recreates the `public` schema. Call it right after
 * `initialize()` and before `runMigrations()`, only on a database the suite owns.
 */
export async function resetSchemaIfMigrationsChanged(dataSource: DataSource): Promise<void> {
  const [{ name }] = (await dataSource.query('SELECT current_database() AS name')) as {
    name: string;
  }[];
  assertSafeToResetSchema(name, testConnectionOptions().host, process.env);

  const hash = createHash('sha256');
  for (const migration of dataSource.migrations) {
    hash.update(migration.name ?? migration.constructor.name);
    hash.update(migration.up.toString());
    hash.update(migration.down?.toString() ?? '');
  }
  const fingerprint = hash.digest('hex');

  await dataSource.query(
    'CREATE TABLE IF NOT EXISTS "test_schema_fingerprint" (fingerprint text NOT NULL)',
  );
  const rows = (await dataSource.query('SELECT fingerprint FROM "test_schema_fingerprint"')) as {
    fingerprint: string;
  }[];
  if (rows.length === 1 && rows[0].fingerprint === fingerprint) return;

  await dataSource.query('DROP SCHEMA public CASCADE');
  await dataSource.query('CREATE SCHEMA public');
  await dataSource.query('CREATE TABLE "test_schema_fingerprint" (fingerprint text NOT NULL)');
  await dataSource.query('INSERT INTO "test_schema_fingerprint" (fingerprint) VALUES ($1)', [
    fingerprint,
  ]);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Refuses to let a schema reset near a database that is not clearly a test one:
 * the name must end in `_test`, and the server must be local unless
 * `ALLOW_TEST_SCHEMA_RESET=1` says otherwise. Database names come from env vars
 * (`BINDING_TEST_DATABASE` and friends), so a typo must not reach a real one.
 */
export function assertSafeToResetSchema(
  database: string,
  host: string,
  env: NodeJS.ProcessEnv,
): void {
  if (!/_test$/.test(database)) {
    throw new Error(`Refusing to reset schema of "${database}": the name must end in "_test"`);
  }
  if (!LOCAL_HOSTS.has(host) && env.ALLOW_TEST_SCHEMA_RESET !== '1') {
    throw new Error(
      `Refusing to reset schema on non-local host "${host}" without ALLOW_TEST_SCHEMA_RESET=1`,
    );
  }
}
