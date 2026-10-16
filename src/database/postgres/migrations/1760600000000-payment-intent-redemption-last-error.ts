import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `payment_intents.redemption_last_error`: the last program error a rail-B
 * redemption attempt was refused with, and — once the provider forfeits the
 * voucher — `provider_forfeit:<cause>`.
 *
 * A retryable refusal such as `ProviderBelowMinimumStake` is retried until the
 * voucher's deadline, and the attempt after that comes back `VoucherExpired`,
 * which no longer says why. The redemption job reads this column to tell a
 * voucher the provider let lapse (its stake fell below the minimum: the
 * provider forfeits, nobody is credited) from one that lapsed for another
 * reason.
 */
export class PaymentIntentRedemptionLastError1760600000000 implements MigrationInterface {
  name = 'PaymentIntentRedemptionLastError1760600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "redemption_last_error" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP COLUMN IF EXISTS "redemption_last_error"`,
    );
  }
}
