import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `payment_intents.redemption_lapsed_at`: buyer debt (no-platform-debt design,
 * steps 9 and 10).
 *
 * A served rail-B call whose voucher can no longer be redeemed, for a reason
 * that is not the provider's (a buyer tightening, an outage, a pause, a late
 * verdict), is not paid by the platform any more. The intent stays `SETTLED`,
 * the buyer's hold stays OPEN, and this column records when the voucher lapsed.
 * While a row of the payer has it set and its hold is open, the payer's paid
 * calls are refused (`PAYMENT_DEBT_OUTSTANDING`) until the buyer signs a
 * replacement voucher, which clears it, or the debt is written off after 30
 * days (`redemption_last_error = 'uncollected:<cause>'`, hold released, the
 * provider not paid).
 *
 * The partial index covers the per-call debt check: it holds only the rows of
 * open debts, which are expected to be few.
 */
export class PaymentIntentRedemptionLapsed1760700000000 implements MigrationInterface {
  name = 'PaymentIntentRedemptionLapsed1760700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "redemption_lapsed_at" timestamptz`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_payment_intents_open_debt"
         ON "payment_intents" ("agent_account", "organization_id")
         WHERE "redemption_lapsed_at" IS NOT NULL AND "hold_released_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_open_debt"`);
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP COLUMN IF EXISTS "redemption_lapsed_at"`,
    );
  }
}
