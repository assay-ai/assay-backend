import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets `next_seq` be rewound, under two conditions, so a payer whose counter
 * ran more than `MAX_SEQ_GAP` ahead of the chain can recover (review S2-2).
 *
 * `AssayEscrow` refuses a voucher more than 1,000,000 above `seqHigh`, and
 * `seqHigh` only moves when a voucher is redeemed. A counter pushed past that
 * gap by unpaid allocations could therefore never issue a usable seq again:
 * nothing could be redeemed, so nothing could move `seqHigh`.
 * `BuyerEscrowRepository.rewindNextSeq` brings it back to just above the
 * highest seq this platform ever RECORDED (and the chain's `seqHigh`).
 *
 * The trigger still refuses every other lowering. A rewind is allowed only:
 *
 * - inside a transaction that set `assay.seq_rewind = 'on'` (`SET LOCAL`, so
 *   it cannot leak into a pooled connection), which only `rewindNextSeq` does;
 * - to a value above every `payment_intents.voucher_seq` of the account,
 *   across organizations (the sequence space is the account's). So a seq that
 *   was ever turned into an intent — served, pending or refused later — can
 *   never be issued again.
 */
export class BuyerEscrowSeqRewind1759600000007 implements MigrationInterface {
  name = 'BuyerEscrowSeqRewind1759600000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_buyer_escrow_seq_monotonic()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.next_seq < OLD.next_seq THEN
          IF COALESCE(current_setting('assay.seq_rewind', true), '') = 'on'
             AND NEW.next_seq > COALESCE(
               (SELECT MAX(pi.voucher_seq) FROM payment_intents pi
                 WHERE pi.agent_account = NEW.account_id AND pi.voucher_seq IS NOT NULL),
               0)
          THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION
            'buyer_escrows.next_seq may only increase; lowering it re-issues sequence numbers the chain has already redeemed'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_buyer_escrow_seq_monotonic()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.next_seq < OLD.next_seq THEN
          RAISE EXCEPTION
            'buyer_escrows.next_seq may only increase; lowering it re-issues sequence numbers the chain has already redeemed'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
  }
}
