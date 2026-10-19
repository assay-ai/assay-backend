import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two partial indexes over the delegate-signed rail-B vouchers, for the
 * payment-key notifications (spec §7.10 item 6):
 *
 * - `idx_payment_intents_delegate_created` (`voucher_delegate`, `created_at`):
 *   "has this key spent before?", asked after each delegate-signed voucher is
 *   admitted (`PaymentKeyFirstSpendService`).
 * - `idx_payment_intents_delegate_recent` (`created_at`): the daily summary's
 *   one cross-tenant pass over yesterday's delegate-signed vouchers.
 *
 * Both are partial on `voucher_delegate IS NOT NULL`, so rail A and
 * payer-signed vouchers cost them nothing.
 */
export class PaymentKeySpendIndexes1762400000020 implements MigrationInterface {
  name = 'PaymentKeySpendIndexes1762400000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_delegate_created" ON "payment_intents" ` +
        `("voucher_delegate", "created_at") WHERE "voucher_delegate" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_delegate_recent" ON "payment_intents" ` +
        `("created_at") WHERE "voucher_delegate" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_delegate_recent"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_delegate_created"`);
  }
}
