import { join } from 'path';

import { Client } from 'pg';

import { AgentEntity } from '@database/postgres/entities/agent.entity';
import { BuyerEscrowEntity } from '@database/postgres/entities/buyer-escrow.entity';
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { VerifierSigningKeyEntity } from '@database/postgres/entities/verifier-signing-key.entity';
import { VerifierSigningLogEntryEntity } from '@database/postgres/entities/verifier-signing-log-entry.entity';
import { DataSource, getMetadataArgsStorage } from 'typeorm';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

/**
 * The widened address and signature columns, asserted against a real Postgres
 * schema rather than against decorators.
 *
 * ## Why this exists next to `test/unit/database/column-widths.spec.ts`
 *
 * The unit spec reads the entity and parses the migration file, so it catches a
 * migration that is missing, narrow, or renames the wrong thing. What it
 * *cannot* catch is the two of them agreeing on paper while Postgres holds
 * something else — a migration that was edited after it was applied, a hand
 * `ALTER` on an environment, an `up()` whose SQL does not do what its author
 * read it as doing.
 *
 * So this suite builds a database **from the migrations themselves**, every one
 * of them, in order, on a scratch database, and then asks
 * `information_schema.columns` what it got. The list of columns is not written
 * down: it is derived from the same TypeORM metadata the application builds its
 * queries from, so a column added to one of these entities is covered here the
 * day it is added.
 *
 * Deleting the migration file turns this red too — the glob picks up whatever
 * is on disk, and the widths that come back are then the pre-multichain ones.
 */
describe('column widths, against a database built from the migrations', () => {
  /**
   * Its own database, created and migrated from scratch. Never the development
   * one: this asserts what the migration chain *produces*, and reading the
   * database a developer has been hand-editing would answer a different
   * question — the one that lets a schema drift and still pass.
   */
  const DATABASE = 'x402_schema_guard_test';

  /** Every entity the widening touches. Their columns are enumerated, not listed. */
  const TARGETS = [
    AgentEntity,
    BuyerEscrowEntity,
    PaymentIntentEntity,
    SlashProposalEntity,
    VerifierSigningKeyEntity,
    VerifierSigningLogEntryEntity,
  ];

  let dataSource: DataSource;

  beforeAll(async () => {
    // DROPPED first, every run. `ensureTestDatabase` alone would create it once
    // and then reuse it, at which point `runMigrations` is a no-op and this
    // suite asserts a schema built by a migration set that may no longer be on
    // disk — it would stay green with the widening migration deleted, which is the
    // single most important thing it has to catch.
    await dropDatabase(DATABASE);
    await ensureTestDatabase(DATABASE);

    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database: DATABASE,
      entities: TARGETS,
      // The glob, not a hand-kept list: a hand-kept list is exactly how a
      // migration gets written and then never applied here.
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });

    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
  }, 300_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  /** `WITH (FORCE)` because a previous run's pool may still be attached. */
  async function dropDatabase(database: string): Promise<void> {
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
      await admin.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }

  /** An entity class, as `getMetadataArgsStorage()` stores it in `column.target`. */
  type EntityClass = { new (...args: never[]): object; readonly name: string };

  const columnsOf = (target: EntityClass) => {
    const table = getMetadataArgsStorage().tables.find((t) => t.target === target);
    if (!table?.name) throw new Error(`no @Entity(name) for ${target.name}`);
    return getMetadataArgsStorage()
      .columns.filter((c) => c.target === target && c.options.type === 'varchar')
      .map((c) => ({
        table: table.name,
        column: c.options.name as string,
        declared: c.options.length as number,
      }));
  };

  it('applied every migration on disk', async () => {
    const [{ count }] = await dataSource.query<[{ count: string }]>(
      'select count(*)::text as count from migrations',
    );
    expect(Number(count)).toBe(dataSource.migrations.length);
    expect(dataSource.migrations.map((m) => m.name)).toContain(
      'WidenSignatureAndAccountColumns1759300000000',
    );
  });

  it('gives every varchar column on these entities exactly the width the entity declares', async () => {
    const expected = TARGETS.flatMap(columnsOf).filter((c) => typeof c.declared === 'number');
    expect(expected.length).toBeGreaterThan(20);

    const actual = new Map<string, number | null>();
    for (const { table } of expected) {
      if ([...actual.keys()].some((k) => k.startsWith(`${table}.`))) continue;
      const rows = await dataSource.query<
        Array<{ column_name: string; character_maximum_length: number | null }>
      >(
        `select column_name, character_maximum_length
           from information_schema.columns
          where table_schema = 'public' and table_name = $1`,
        [table],
      );
      for (const row of rows) {
        actual.set(`${table}.${row.column_name}`, row.character_maximum_length);
      }
    }

    // One assertion over the whole set rather than a loop of `expect`s: a loop
    // reports the first mismatch and hides the rest, and "which columns drifted"
    // is the question being asked.
    const drift = expected
      .filter((c) => actual.get(`${c.table}.${c.column}`) !== c.declared)
      .map((c) => ({
        column: `${c.table}.${c.column}`,
        entity: c.declared,
        database: actual.get(`${c.table}.${c.column}`) ?? 'no such column',
      }));

    expect(drift).toEqual([]);
  });

  it('holds the renamed escrow columns under their new names, and not their old ones', async () => {
    const rows = await dataSource.query<Array<{ column_name: string }>>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'buyer_escrows'`,
    );
    const names = rows.map((r) => r.column_name);

    expect(names).toContain('escrow_account_id');
    expect(names).toContain('escrow_asset_account_id');
    expect(names).not.toContain('escrow_pda');
    expect(names).not.toContain('escrow_token_account');
  });

  it('physically accepts the longest legal value every widened column must hold', async () => {
    // `CREATE TABLE … AS SELECT <column> … WITH NO DATA` inherits the source
    // column's typmod, so this is the real width being tested and nothing is
    // written to a real table. Reading `character_maximum_length` would only
    // re-assert the catalogue the previous case already read.
    const SECP256K1_SIGNATURE = `0x${'a'.repeat(130)}`;
    const MAX_ACCOUNT_ID = `${'e'.repeat(8)}:${'1'.repeat(32)}:${'A'.repeat(128)}`;

    const probes: ReadonlyArray<[string, string, string]> = [
      ['payment_intents', 'voucher_signature', SECP256K1_SIGNATURE],
      ['slash_proposals', 'chain_proposal_signature', SECP256K1_SIGNATURE],
      ['slash_proposals', 'execution_signature', SECP256K1_SIGNATURE],
      ['slash_proposals', 'reversal_signature', SECP256K1_SIGNATURE],
      ['verifier_signing_keys', 'public_key', SECP256K1_SIGNATURE],
      ['verifier_signing_keys', 'chain_address', MAX_ACCOUNT_ID],
      ['verifier_signing_log', 'public_key', SECP256K1_SIGNATURE],
      ['verifier_signing_log', 'signature', SECP256K1_SIGNATURE],
      ['buyer_escrows', 'escrow_account_id', MAX_ACCOUNT_ID],
      ['buyer_escrows', 'escrow_asset_account_id', MAX_ACCOUNT_ID],
      ['agents', 'primary_account_id', MAX_ACCOUNT_ID],
    ];

    const refused: string[] = [];
    for (const [table, column, value] of probes) {
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.query(
          `CREATE TEMP TABLE probe AS SELECT "${column}" FROM "${table}" WITH NO DATA`,
        );
        await runner.query('INSERT INTO probe VALUES ($1)', [value]);
      } catch (error) {
        refused.push(`${table}.${column}: ${(error as Error).message}`);
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    }

    expect(refused).toEqual([]);
  });
});
