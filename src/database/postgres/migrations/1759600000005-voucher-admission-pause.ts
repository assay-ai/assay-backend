import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `voucher_admission_pauses` — a payer whose caps are being tightened takes no
 * new rail-B voucher until the change has landed (BUG-D1-07).
 *
 * A relayed change that lowers a cap (the escrow's limits, or a delegate's
 * caps, expiry or authority) is checked against every voucher of the payer the
 * chain has not redeemed yet, and refused when it would strand one. Between
 * that check and the transaction landing, a voucher admitted under the OLD caps
 * would be stranded by the NEW ones without anyone being asked. So the check
 * writes a row here, under the same per-payer advisory lock the admission
 * takes (`PaymentIntentRepository.insertAdmittedVoucherIntent`), and the
 * admission refuses, retryably, while `paused_until` is in the future.
 *
 * One row per payer account, overwritten; a row in the past is inert, so
 * nothing ever has to delete one for correctness. `paused_until` is always a
 * short, bounded instant: a crashed relay frees the payer on its own.
 */
export class VoucherAdmissionPause1759600000005 implements MigrationInterface {
  name = 'VoucherAdmissionPause1759600000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "voucher_admission_pauses" (` +
        `"payer_account" varchar(256) NOT NULL, ` +
        `"paused_until" timestamptz NOT NULL, ` +
        `"updated_at" timestamptz NOT NULL DEFAULT now(), ` +
        `CONSTRAINT "pk_voucher_admission_pauses" PRIMARY KEY ("payer_account"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "voucher_admission_pauses"`);
  }
}
