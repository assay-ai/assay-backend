import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops schema that only the retired code paths used.
 *
 * - `provider_payouts` and `providers.payout_threshold_override`: the hourly
 *   payout batch is gone. A provider is paid in the transaction that redeems
 *   the voucher, so nothing writes a payout run or reads a threshold.
 * - `payment_intents.voucher_nonce`, its unique index, its rail-A CHECK and its
 *   immutability trigger: voucher v1. Nothing writes a nonce; voucher v2's
 *   `voucher_seq` is the replay guard.
 *
 * The rail-B insert rule stays, narrowed to the seq: a `RAIL_B_VOUCHER` intent
 * cannot come into existence without the seq it was authorised by. Still a
 * BEFORE INSERT trigger rather than a CHECK, for the reason `1755300000000`
 * gives (a CHECK would make older rows unmodifiable).
 *
 * `down` recreates what was dropped, empty, and puts back the nonce-or-seq
 * rule as `1759100000000` left it.
 */
export class DropLegacyPaymentSchema1762400000000 implements MigrationInterface {
  name = 'DropLegacyPaymentSchema1762400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "provider_payouts"`);
    await queryRunner.query(`ALTER TABLE "providers" DROP COLUMN "payout_threshold_override"`);

    await queryRunner.query(
      `DROP TRIGGER "trg_payment_intents_rail_b_has_nonce" ON "payment_intents"`,
    );
    await queryRunner.query(`DROP FUNCTION assert_rail_b_intent_has_voucher_nonce()`);
    await queryRunner.query(
      `DROP TRIGGER "trg_payment_intents_voucher_nonce_immutable" ON "payment_intents"`,
    );
    await queryRunner.query(`DROP FUNCTION assert_voucher_nonce_is_immutable()`);
    await queryRunner.query(`DROP INDEX "idx_payment_intents_voucher_nonce"`);
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP CONSTRAINT "chk_payment_intents_rail_a_has_no_nonce"`,
    );
    await queryRunner.query(`ALTER TABLE "payment_intents" DROP COLUMN "voucher_nonce"`);

    await queryRunner.query(`
      CREATE FUNCTION assert_rail_b_intent_has_voucher_seq()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.rail = 'RAIL_B_VOUCHER' AND NEW.voucher_seq IS NULL THEN
          RAISE EXCEPTION
            'a RAIL_B_VOUCHER payment intent must record the voucher seq it was authorised by'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_payment_intents_rail_b_has_seq
        BEFORE INSERT ON "payment_intents"
        FOR EACH ROW EXECUTE FUNCTION assert_rail_b_intent_has_voucher_seq()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER "trg_payment_intents_rail_b_has_seq" ON "payment_intents"`,
    );
    await queryRunner.query(`DROP FUNCTION assert_rail_b_intent_has_voucher_seq()`);

    await queryRunner.query(
      `ALTER TABLE "payment_intents" ADD COLUMN "voucher_nonce" character varying(64) NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "payment_intents" ADD CONSTRAINT "chk_payment_intents_rail_a_has_no_nonce" CHECK (
        "rail" = 'RAIL_B_VOUCHER' OR "voucher_nonce" IS NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_payment_intents_voucher_nonce"
        ON "payment_intents" ("voucher_nonce")
        WHERE "voucher_nonce" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE FUNCTION assert_voucher_nonce_is_immutable()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.voucher_nonce IS DISTINCT FROM OLD.voucher_nonce THEN
          RAISE EXCEPTION
            'payment_intents.voucher_nonce is immutable; changing it returns a spent voucher to circulation'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_payment_intents_voucher_nonce_immutable
        BEFORE UPDATE OF "voucher_nonce" ON "payment_intents"
        FOR EACH ROW EXECUTE FUNCTION assert_voucher_nonce_is_immutable()
    `);
    await queryRunner.query(`
      CREATE FUNCTION assert_rail_b_intent_has_voucher_nonce()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.rail = 'RAIL_B_VOUCHER'
           AND NEW.voucher_nonce IS NULL
           AND NEW.voucher_seq IS NULL THEN
          RAISE EXCEPTION
            'a RAIL_B_VOUCHER payment intent must record the voucher seq (v2) or nonce (v1) it was authorised by'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_payment_intents_rail_b_has_nonce
        BEFORE INSERT ON "payment_intents"
        FOR EACH ROW EXECUTE FUNCTION assert_rail_b_intent_has_voucher_nonce()
    `);

    await queryRunner.query(`
      ALTER TABLE "providers"
        ADD COLUMN "payout_threshold_override" numeric(78, 0)
    `);

    await queryRunner.query(`
      CREATE TABLE "provider_payouts" (
        "id"                        uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"                timestamptz   NOT NULL DEFAULT now(),
        "updated_at"                timestamptz   NOT NULL DEFAULT now(),
        "version"                   integer       NOT NULL DEFAULT 1,
        "organization_id"           uuid          NOT NULL,
        "asset_id"                  varchar(256)  NOT NULL,
        "decimals"                  integer       NOT NULL,
        "period_start"              timestamptz   NOT NULL,
        "period_end"                timestamptz   NOT NULL,
        "amount"                    numeric(78,0) NOT NULL,
        "from_seq"                  bigint        NOT NULL DEFAULT 0,
        "to_seq"                    bigint        NOT NULL,
        "call_count"                integer       NOT NULL,
        "status"                    varchar(16)   NOT NULL DEFAULT 'PENDING',
        "batch_id"                  uuid          NOT NULL,
        "source_account_id"         varchar(256)  NOT NULL,
        "payout_account_id"         varchar(256)  NOT NULL,
        "chain_tx_ref"              varchar(256),
        "ledger_entry_id"           uuid,
        CONSTRAINT "pk_provider_payouts" PRIMARY KEY ("id"),
        CONSTRAINT "uq_provider_payouts_org_asset_period"
          UNIQUE ("organization_id", "asset_id", "period_start"),
        CONSTRAINT "chk_provider_payouts_status"
          CHECK ("status" IN ('PENDING', 'SUBMITTED', 'RECORDED')),
        CONSTRAINT "chk_provider_payouts_seq_order"
          CHECK ("to_seq" >= "from_seq"),
        CONSTRAINT "chk_provider_payouts_amount_positive"
          CHECK ("amount" > 0),
        CONSTRAINT "chk_provider_payouts_call_count_positive"
          CHECK ("call_count" > 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_provider_payouts_organization_id" ON "provider_payouts" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_provider_payouts_batch_id" ON "provider_payouts" ("organization_id", "batch_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_provider_payouts_status" ON "provider_payouts" ("status")`,
    );
  }
}
