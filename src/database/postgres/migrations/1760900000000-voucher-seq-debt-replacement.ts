import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a buyer debt's REPLACEMENT voucher take the row's `voucher_seq`
 * (BUG-R17f-01), and nothing else.
 *
 * `trg_payment_intents_voucher_seq_immutable` (1759100000000) refused every
 * change of `voucher_seq`, so `PaymentIntentRepository.replaceLapsedVoucher`
 * — which writes the replacement's fresh seq onto the debt's row — failed on
 * every settlement, and no debt could ever be settled.
 *
 * The rule the trigger protects is "a spent voucher never returns to
 * circulation". A seq may now change ONLY in the one UPDATE that replaces a
 * lapsed voucher, and only when the old voucher is provably dead on chain:
 *
 * - `OLD.rail = 'RAIL_B_VOUCHER'` and `OLD.voucher_seq` was set;
 * - `OLD.redemption_lapsed_at IS NOT NULL`: the row is buyer debt — the
 *   redemption job gave up on the old voucher and none of its own
 *   transactions landed (`VoucherRedemptionService.closeUnredeemable`);
 * - `OLD.redemption_replaced_at IS NULL` and `NEW.redemption_replaced_at IS
 *   NOT NULL`: this UPDATE is the replacement, and the row was not already
 *   being replaced (one replacement per lapse);
 * - `NEW.voucher_seq > OLD.voucher_seq`: forward only — the chain admits a
 *   voucher only above the payer's `seqHigh`, so redeeming the new seq makes
 *   the old one unredeemable for good;
 * - `now() > OLD.expires_at + 1920 s`: the old voucher is past its on-chain
 *   deadline. The contract refuses a voucher once `block.timestamp >
 *   expiresAt + REDEEM_GRACE_SECONDS` (1,800 s); 120 s more
 *   (`CLOCK_SKEW_TOLERANCE_SECONDS`) covers a block clock ahead of the
 *   database's. Kept equal to `DEBT_REPLACEABLE_AFTER_EXPIRY_SECONDS`.
 *
 * Why the deadline clause and not just "lapsed": not every lapse comes after
 * the deadline. `VoucherExpired` does, but a permanent refusal that is not
 * the provider's (no escrow, an unfunded one, …) lapses at once, and a buyer
 * tightening (`DelegateIsRevoked`, a lowered cap) or a late verdict lapses up
 * to `REDEMPTION_DEADLINE_MARGIN_SECONDS` (60 s) BEFORE it. Until the
 * deadline the old voucher can still be redeemed — a re-grant, a funded
 * escrow — and with a replacement at a higher seq redeemed after it, the
 * buyer would pay twice. Past the deadline the old voucher is refused
 * whatever happens, so swapping it out returns nothing to circulation.
 * `BuyerDebtService` refuses a replacement before this time with a 409, so
 * the trigger is the backstop, not the gate a buyer meets.
 *
 * Every other change still raises. The other columns
 * `replaceLapsedVoucher` writes (`voucher_signature`, `voucher_issued_at`,
 * `voucher_delegate`, `expires_at`, `voucher_resource_hash`,
 * `voucher_resource`, `redemption_tx_refs`) carry no immutability trigger;
 * `trg_payment_intents_voucher_nonce_immutable` fires only on
 * `UPDATE OF voucher_nonce`, which it does not write.
 */
export class VoucherSeqDebtReplacement1760900000000 implements MigrationInterface {
  name = 'VoucherSeqDebtReplacement1760900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
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
                    AND NEW.redemption_replaced_at IS NOT NULL
                    AND now() > OLD.expires_at + interval '1920 seconds') THEN
          RAISE EXCEPTION
            'payment_intents.voucher_seq is immutable; changing it returns a spent voucher to circulation (only a lapsed debt past its old voucher''s on-chain deadline may take a higher replacement seq)'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_voucher_seq_is_immutable()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.voucher_seq IS DISTINCT FROM OLD.voucher_seq THEN
          RAISE EXCEPTION
            'payment_intents.voucher_seq is immutable; changing it returns a spent voucher to circulation'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
  }
}
