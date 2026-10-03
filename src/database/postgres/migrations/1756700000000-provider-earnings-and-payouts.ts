import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The provider earnings ledger and the hourly payout batch.
 *
 * ## `uq_ledger_entries_intent_credit_type`
 *
 * A partial unique index on `ledger_entries (organization_id, intent_id,
 * entry_type)`, restricted to `entry_type IN ('PROVIDER_CREDIT',
 * 'PLATFORM_FEE')`. `LedgerHoldService.commitHoldAndCredit` already writes
 * both entries inside the same transaction as the `HOLD_COMMIT` they replace,
 * which closes the crash window for *that* call — but a transaction only
 * protects against a crash inside itself, not against a second, independent
 * writer reaching the same intent through some other path (a repair script, a
 * future caller that forgets `commitHoldAndCredit` exists and calls
 * `LedgerService.append` directly). This index is what refuses that at the
 * database, unconditionally, the same way `uq_verification_records_intent`
 * backs `VerificationSettlementService`'s own idempotency.
 *
 * ## `provider_payouts`
 *
 * See `ProviderPayoutEntity` for the full reasoning behind every column here;
 * the migration only needs to get the constraints right.
 * `uq_provider_payouts_org_asset_period` is the guard that makes a re-run of
 * the same hourly period a no-op decided by Postgres rather than by a
 * read-then-write two scheduler instances could interleave.
 *
 * ## `providers.payout_threshold_override`
 *
 * A configurable payout threshold, above the platform default only. Added here
 * because the column is cheap and the service that reads it
 * (`ProviderPayoutBatchService`) is built in the same change; there is no write
 * path for it yet (no controller sets it).
 */
export class ProviderEarningsAndPayouts1756700000000 implements MigrationInterface {
  name = 'ProviderEarningsAndPayouts1756700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_ledger_entries_intent_credit_type"
        ON "ledger_entries" ("organization_id", "intent_id", "entry_type")
        WHERE "entry_type" IN ('PROVIDER_CREDIT', 'PLATFORM_FEE')
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "provider_payouts"`);
    await queryRunner.query(
      `ALTER TABLE "providers" DROP COLUMN IF EXISTS "payout_threshold_override"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_ledger_entries_intent_credit_type"`);
  }
}
