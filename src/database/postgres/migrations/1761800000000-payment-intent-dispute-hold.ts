import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The dispute hold on a call (G3.B1, "redeem into hold", analysis §5):
 *
 * - `held_status`: the call's payment is held, not yet the provider's —
 *   rail B: the escrow's `held[payer][seq]` record (`HELD` from `PaymentHeld`,
 *   then `COLLECTED` from `HeldCollected` or `REFUNDED` from `HeldRefunded`);
 *   rail A: the provider's ledger credit withheld for the hold window.
 * - `held_at`: when the voucher was redeemed into the hold.
 * - `collectable_at`: from the record (`PaymentHeld.collectableAt`); rail A:
 *   settlement + `CALL_DISPUTE_HOLD_WINDOW_MINUTES`.
 * - `held_tx_ref`: the collect or refund transaction.
 * - `dispute_outcome`: `OPEN` while a guaranteed dispute keeps the hold from
 *   being collected, then `UPHELD` | `REJECTED`. The quality stats count an
 *   upheld call as a failed one.
 */
export class PaymentIntentDisputeHold1761800000000 implements MigrationInterface {
  name = 'PaymentIntentDisputeHold1761800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        ADD COLUMN "held_status" character varying(12) NULL,
        ADD COLUMN "held_at" timestamptz NULL,
        ADD COLUMN "collectable_at" timestamptz NULL,
        ADD COLUMN "held_tx_ref" text NULL,
        ADD COLUMN "dispute_outcome" character varying(16) NULL,
        ADD CONSTRAINT "chk_payment_intents_held_status" CHECK (
          "held_status" IS NULL OR "held_status" IN ('HELD', 'COLLECTED', 'REFUNDED')
        ),
        ADD CONSTRAINT "chk_payment_intents_held_is_whole" CHECK (
          "held_status" IS NULL OR ("held_at" IS NOT NULL AND "collectable_at" IS NOT NULL)
        ),
        ADD CONSTRAINT "chk_payment_intents_dispute_outcome" CHECK (
          "dispute_outcome" IS NULL OR "dispute_outcome" IN ('OPEN', 'UPHELD', 'REJECTED')
        )
    `);
    // The collection job's queue: held, past the window.
    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_held_collectable" ON "payment_intents" ` +
        `("collectable_at") WHERE "held_status" = 'HELD'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_payment_intents_held_collectable"`);
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        DROP CONSTRAINT "chk_payment_intents_dispute_outcome",
        DROP CONSTRAINT "chk_payment_intents_held_is_whole",
        DROP CONSTRAINT "chk_payment_intents_held_status",
        DROP COLUMN "dispute_outcome",
        DROP COLUMN "held_tx_ref",
        DROP COLUMN "collectable_at",
        DROP COLUMN "held_at",
        DROP COLUMN "held_status"
    `);
  }
}
