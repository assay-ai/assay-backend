import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Buyer debt, second review (review-buyer-debt 2026-10-16, H1, M4, L5).
 *
 * - `payment_intents.redemption_replaced_at`: when the buyer's REPLACEMENT
 *   voucher for an open debt was accepted. The debt stays a debt —
 *   `redemption_lapsed_at` is kept, so the 30-day write-off clock never
 *   restarts — and the row goes back to the redemption queue. Paid calls stay
 *   refused until the replacement is collected (its hold committed). A
 *   replacement that lapses again clears this column and is plain debt again.
 * - `payment_intents.voucher_resource`: the `resource` string the voucher
 *   signed (`/mcp/tools/<name>`). A debt's replacement must sign the same one,
 *   and the tool may have been renamed or deleted since; NULL on rows written
 *   before this column (the tool is looked up then).
 * - `idx_payment_intents_open_debt` now also covers WRITTEN-OFF debts: until
 *   the contract change ships, a write-off ends the hold and the provider's
 *   wait but never the payer's refusal (H1 interim).
 *
 * Additive and idempotent. There is no safe rollback past this migration and
 * 1760700000000: see `docs/runbooks/buyer-debt-deploy.md`.
 */
export class PaymentIntentDebtReplacing1760800000000 implements MigrationInterface {
  name = 'PaymentIntentDebtReplacing1760800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "redemption_replaced_at" timestamptz`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "voucher_resource" text`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_open_debt"`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_payment_intents_open_debt"
         ON "payment_intents" ("agent_account", "organization_id")
         WHERE "redemption_lapsed_at" IS NOT NULL
           AND ("hold_released_at" IS NULL OR "redemption_last_error" LIKE 'uncollected:%')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_open_debt"`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_payment_intents_open_debt"
         ON "payment_intents" ("agent_account", "organization_id")
         WHERE "redemption_lapsed_at" IS NOT NULL AND "hold_released_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP COLUMN IF EXISTS "voucher_resource"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP COLUMN IF EXISTS "redemption_replaced_at"`,
    );
  }
}
