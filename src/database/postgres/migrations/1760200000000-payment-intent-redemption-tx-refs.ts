import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `payment_intents.redemption_tx_refs`: every transaction the redemption job
 * signed to redeem this rail-B voucher, recorded BEFORE its broadcast.
 *
 * A redemption that landed but whose receipt this process never saw (a
 * receipt timeout, a restart) comes back on the next pass as
 * `VoucherSeqNotIncreasing`, exactly like a voucher that can never land. The
 * job reads these references to tell the two apart on chain, and retires the
 * hold with the transaction that paid instead of absorbing it — which paid the
 * provider a second time (review 2026-10-15 P-1).
 */
export class PaymentIntentRedemptionTxRefs1760200000000 implements MigrationInterface {
  name = 'PaymentIntentRedemptionTxRefs1760200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "redemption_tx_refs" text[] NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP COLUMN IF EXISTS "redemption_tx_refs"`,
    );
  }
}
