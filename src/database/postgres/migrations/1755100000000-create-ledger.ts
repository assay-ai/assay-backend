import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The append-only journal, its balance snapshot and its holds.
 *
 * Hand-written rather than generated, and this is the documented exception to
 * the "migrations are generated" rule in `docs/architecture.md`. Three of the four
 * guarantees this schema exists to provide cannot be expressed as entity
 * decorators, so a generated migration would silently omit them:
 *
 *  - `seq BIGSERIAL` — the journal's only total order;
 *  - the `BEFORE UPDATE OR DELETE` trigger that makes append-only a database
 *    fact rather than a code review outcome;
 *  - the partial unique index that allows exactly one OPEN hold per intent.
 *
 * Everything after this one is generated normally.
 */
export class CreateLedger1755100000000 implements MigrationInterface {
  name = 'CreateLedger1755100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // ── ledger_entries — the journal ──────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "ledger_entries" (
        "id"              uuid            NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      TIMESTAMP       NOT NULL DEFAULT now(),
        "updated_at"      TIMESTAMP       NOT NULL DEFAULT now(),
        "version"         integer         NOT NULL DEFAULT 1,
        "organization_id" uuid            NOT NULL,
        "seq"             BIGSERIAL       NOT NULL,
        "account_id"      character varying(256) NOT NULL,
        "entry_type"      character varying(32)  NOT NULL,
        "amount"          numeric(78,0)   NOT NULL,
        "asset_id"        character varying(256) NOT NULL,
        "decimals"        integer         NOT NULL,
        "intent_id"       uuid            NULL,
        "hold_id"         uuid            NULL,
        "batch_id"        uuid            NULL,
        "chain_tx_ref"    character varying(256) NULL,
        CONSTRAINT "pk_ledger_entries" PRIMARY KEY ("id"),
        CONSTRAINT "chk_ledger_entries_amount_unsigned" CHECK ("amount" >= 0)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_ledger_entries_organization_id" ON "ledger_entries" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ledger_entries_account_asset_seq" ON "ledger_entries" ` +
        `("organization_id", "account_id", "asset_id", "seq")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ledger_entries_intent_id" ON "ledger_entries" ("organization_id", "intent_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ledger_entries_hold_id" ON "ledger_entries" ("organization_id", "hold_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ledger_entries_batch_id" ON "ledger_entries" ("organization_id", "batch_id")`,
    );

    // The append-only guarantee, enforced where it cannot be bypassed.
    //
    // Convention is what a reviewer checks; a trigger is what holds when an ORM
    // feature, a migration or a psql session tries to rewrite a financial
    // record at 3am. `TRUNCATE` is covered by a statement-level trigger because
    // a row-level one never fires for it.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ledger_entries_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'ledger_entries is append-only: % is not permitted', TG_OP
          USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_ledger_entries_append_only
        BEFORE UPDATE OR DELETE ON "ledger_entries"
        FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only()
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_ledger_entries_no_truncate
        BEFORE TRUNCATE ON "ledger_entries"
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_append_only()
    `);

    // ── ledger_holds — reservations ───────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "ledger_holds" (
        "id"               uuid           NOT NULL DEFAULT gen_random_uuid(),
        "created_at"       TIMESTAMP      NOT NULL DEFAULT now(),
        "updated_at"       TIMESTAMP      NOT NULL DEFAULT now(),
        "version"          integer        NOT NULL DEFAULT 1,
        "organization_id"  uuid           NOT NULL,
        "account_id"       character varying(256) NOT NULL,
        "amount"           numeric(78,0)  NOT NULL,
        "asset_id"         character varying(256) NOT NULL,
        "decimals"         integer        NOT NULL,
        "status"           character varying(16)  NOT NULL,
        "intent_id"        uuid           NOT NULL,
        "create_entry_id"  uuid           NOT NULL,
        "resolve_entry_id" uuid           NULL,
        "expires_at"       TIMESTAMP WITH TIME ZONE NULL,
        CONSTRAINT "pk_ledger_holds" PRIMARY KEY ("id"),
        CONSTRAINT "chk_ledger_holds_amount_positive" CHECK ("amount" > 0),
        CONSTRAINT "chk_ledger_holds_status" CHECK ("status" IN ('OPEN', 'RELEASED', 'COMMITTED')),
        CONSTRAINT "chk_ledger_holds_resolved_has_entry" CHECK (
          ("status" = 'OPEN' AND "resolve_entry_id" IS NULL)
          OR ("status" <> 'OPEN' AND "resolve_entry_id" IS NOT NULL)
        )
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_ledger_holds_organization_id" ON "ledger_holds" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ledger_holds_account_status" ON "ledger_holds" ` +
        `("organization_id", "account_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ledger_holds_expires_at" ON "ledger_holds" ("status", "expires_at")`,
    );

    // At most one OPEN hold per intent. Without it a retried createHold
    // reserves the money twice and nobody ever releases the second one.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_ledger_holds_open_intent"
        ON "ledger_holds" ("organization_id", "intent_id")
        WHERE "status" = 'OPEN'
    `);

    // ── account_balances — the snapshot ───────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "account_balances" (
        "id"              uuid           NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      TIMESTAMP      NOT NULL DEFAULT now(),
        "updated_at"      TIMESTAMP      NOT NULL DEFAULT now(),
        "version"         integer        NOT NULL DEFAULT 1,
        "organization_id" uuid           NOT NULL,
        "account_id"      character varying(256) NOT NULL,
        "asset_id"        character varying(256) NOT NULL,
        "decimals"        integer        NOT NULL,
        "available"       numeric(78,0)  NOT NULL DEFAULT '0',
        "held"            numeric(78,0)  NOT NULL DEFAULT '0',
        "pending"         numeric(78,0)  NOT NULL DEFAULT '0',
        CONSTRAINT "pk_account_balances" PRIMARY KEY ("id"),
        CONSTRAINT "chk_account_balances_non_negative"
          CHECK ("available" >= 0 AND "held" >= 0 AND "pending" >= 0)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_account_balances_organization_id" ON "account_balances" ("organization_id")`,
    );
    // Unique, and therefore also the conflict target `ensureRows` relies on.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_account_balances_account_asset"
        ON "account_balances" ("organization_id", "account_id", "asset_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "account_balances"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ledger_holds"`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_ledger_entries_no_truncate" ON "ledger_entries"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_ledger_entries_append_only" ON "ledger_entries"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "ledger_entries"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS ledger_entries_append_only()`);
  }
}
