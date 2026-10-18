import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops schema that only the retired code paths used.
 *
 * - `provider_payouts` and `providers.payout_threshold_override`: the hourly
 *   payout batch is gone. A provider is paid in the transaction that redeems
 *   the voucher, so nothing writes a payout run or reads a threshold.
 *
 * `down` recreates them exactly as `1756700000000` made them, empty.
 */
export class DropLegacyPaymentSchema1762300000000 implements MigrationInterface {
  name = 'DropLegacyPaymentSchema1762300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "provider_payouts"`);
    await queryRunner.query(`ALTER TABLE "providers" DROP COLUMN "payout_threshold_override"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
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
