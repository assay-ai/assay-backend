import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `idx_payment_intents_voucher_admission` — the read that admits a rail-B
 * voucher (BUG-D1-02).
 *
 * Before a voucher is served, `PaymentIntentRepository.insertAdmittedVoucherIntent`
 * sums, under the payer's advisory lock, every voucher of the payer the chain's
 * window counters do not hold yet: in flight, served and unredeemed (hold not
 * closed), or redeemed after the counter was read (hold closed after an
 * instant). Every one of those has `hold_released_at` NULL or recent, so an
 * index on `(agent_account, hold_released_at)` over rail B reaches them without
 * scanning the payer's whole history.
 */
export class VoucherAdmissionIndex1759600000003 implements MigrationInterface {
  name = 'VoucherAdmissionIndex1759600000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_voucher_admission" ` +
        `ON "payment_intents" ("agent_account", "hold_released_at") ` +
        `WHERE "rail" = 'RAIL_B_VOUCHER'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_voucher_admission"`);
  }
}
