import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the deadline clause of `trg_payment_intents_voucher_seq_immutable`
 * per chain (assay-evm D-24).
 *
 * `VoucherSeqDebtReplacement1760900000000` lets a buyer debt's replacement
 * voucher take a higher `voucher_seq` only once the old voucher is past its
 * on-chain deadline: `now() > OLD.expires_at + 1920 s`, the redemption grace
 * (1,800 s) plus `CLOCK_SKEW_TOLERANCE_SECONDS` (120 s). `AssayEscrow` raised
 * its grace to 7,200 s, so on `eip155` a voucher stays redeemable until
 * `expires_at + 7200`, and a replacement accepted between 1,920 s and 7,320 s
 * could be redeemed beside the old voucher — the buyer charged twice.
 *
 * The bound is now read off the row's own `chain_id`: 7,320 s on `eip155`,
 * 1,920 s elsewhere (Solana, unchanged). Kept equal to
 * `debtReplaceableAfterExpirySeconds`, which `BuyerDebtService` gates on first;
 * the trigger is the backstop. Every other clause is unchanged.
 */
export class VoucherSeqDebtReplacementPerChain1762400000050 implements MigrationInterface {
  name = 'VoucherSeqDebtReplacementPerChain1762400000050';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      replacementGuard(`
                    AND now() > OLD.expires_at + CASE
                          WHEN split_part(OLD.chain_id, ':', 1) = 'eip155'
                          THEN interval '7320 seconds'
                          ELSE interval '1920 seconds'
                        END`),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      replacementGuard(`
                    AND now() > OLD.expires_at + interval '1920 seconds'`),
    );
  }
}

function replacementGuard(deadlineClause: string): string {
  return `
      CREATE OR REPLACE FUNCTION assert_voucher_seq_is_immutable()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.voucher_seq IS DISTINCT FROM OLD.voucher_seq
           AND NOT (OLD.rail = 'RAIL_B_VOUCHER'
                    AND OLD.voucher_seq IS NOT NULL
                    AND NEW.voucher_seq IS NOT NULL
                    AND NEW.voucher_seq > OLD.voucher_seq
                    AND OLD.redemption_lapsed_at IS NOT NULL
                    AND OLD.redemption_replaced_at IS NULL
                    AND NEW.redemption_replaced_at IS NOT NULL${deadlineClause}) THEN
          RAISE EXCEPTION
            'payment_intents.voucher_seq is immutable; changing it returns a spent voucher to circulation (only a lapsed debt past its old voucher''s on-chain deadline may take a higher replacement seq)'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
}
