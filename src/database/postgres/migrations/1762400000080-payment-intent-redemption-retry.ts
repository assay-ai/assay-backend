import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A back-off for rail-B redemptions the chain refused with a retryable error
 * (review 2026-10-23 I-1).
 *
 * Since D-23 a payer's open vouchers are no longer held back behind its lowest
 * seq on `eip155`, so one payer (or one provider) can have any number of rows
 * in the redemption queue. A row refused with a retryable error stayed
 * eligible on every pass until its deadline — up to two hours on `eip155` —
 * and could fill the pass's `LIMIT` ahead of rows that would redeem.
 *
 * - `redemption_attempts`: retryable refusals so far.
 * - `redemption_retry_at`: not attempted again before this instant (1, 2, 4,
 *   8, then every 10 minutes, and never past the voucher's last pass).
 *
 * Only read for chains that admit any seq order (`eip155`). Solana keeps one
 * row per payer in the queue and is unchanged.
 */
export class PaymentIntentRedemptionRetry1762400000080 implements MigrationInterface {
  name = 'PaymentIntentRedemptionRetry1762400000080';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        ADD COLUMN "redemption_attempts" integer NOT NULL DEFAULT 0,
        ADD COLUMN "redemption_retry_at" timestamptz NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        DROP COLUMN "redemption_retry_at",
        DROP COLUMN "redemption_attempts"
    `);
  }
}
