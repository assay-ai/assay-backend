import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The dispute hold on a call (G3.B1):
 *
 * - `collectable_at`: a SETTLED rail-B voucher is not redeemed before this
 *   (`collection-hold.constants.ts`). NULL — settled before the hold existed,
 *   or a debt's replacement — is collectable.
 * - `dispute_outcome`: `OPEN` while a dispute filed inside the hold keeps the
 *   voucher out of the redemption queue, then `UPHELD` | `REJECTED`. The quality
 *   stats count an upheld call as a failed one.
 */
export class PaymentIntentDisputeHold1761800000000 implements MigrationInterface {
  name = 'PaymentIntentDisputeHold1761800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        ADD COLUMN "collectable_at" timestamptz NULL,
        ADD COLUMN "dispute_outcome" character varying(16) NULL,
        ADD CONSTRAINT "chk_payment_intents_dispute_outcome" CHECK (
          "dispute_outcome" IS NULL OR "dispute_outcome" IN ('OPEN', 'UPHELD', 'REJECTED')
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        DROP CONSTRAINT "chk_payment_intents_dispute_outcome",
        DROP COLUMN "dispute_outcome",
        DROP COLUMN "collectable_at"
    `);
  }
}
