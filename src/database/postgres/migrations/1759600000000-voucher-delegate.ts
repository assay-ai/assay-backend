import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `payment_intents.voucher_delegate` — agent payment delegation.
 *
 * A rail-B voucher on eip155 may be signed by a DELEGATE key the payer
 * authorised on chain (`X402Escrow.authorizeDelegate[BySig]`) instead of by the
 * payer's own key. The column records that delegate (CAIP-10, 256 wide like
 * every account column), and is NULL when the payer — or the payer's EIP-1271
 * wallet — signed.
 *
 * It exists for one read before the call is served: the delegate's on-chain
 * window counts only REDEEMED vouchers, so the delegate's vouchers that hold
 * money and have not reached the chain yet must be added from here, or two
 * calls could each fit a window that both together overflow — and the second
 * would be served and then refused at redemption.
 *
 * The partial index covers exactly that read: open holds, by payer and
 * delegate.
 */
export class VoucherDelegate1759600000000 implements MigrationInterface {
  name = 'VoucherDelegate1759600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ADD COLUMN "voucher_delegate" varchar(256) NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_voucher_delegate_open" ` +
        `ON "payment_intents" ("agent_account", "voucher_delegate") ` +
        `WHERE "voucher_delegate" IS NOT NULL AND "hold_id" IS NOT NULL ` +
        `AND "hold_released_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_voucher_delegate_open"`);
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP COLUMN IF EXISTS "voucher_delegate"`,
    );
  }
}
