import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The mirror of each buyer's on-chain escrow, and the sequence number
 * that replaces the rail-B nonce.
 *
 * Hand-written, like every migration in this directory that carries a rule a
 * decorator cannot express. Four of those here:
 *
 *  - **`buyer_escrows.next_seq` is the allocator, and it is in Postgres.**
 *    Redis would be the obvious home, but a counter a cache flush resets to 1
 *    re-issues sequence numbers the chain has already redeemed; the buyer signs
 *    them, the platform serves the call, and the redemption dies on the chain's
 *    own sequence rule. `voucher-nonce.store.ts` made the same argument about
 *    its own fast layer: *"flushing Redis must never enable a double spend."*
 *  - **one escrow per account — not per agent, not per organization and not
 *    per asset.** The escrow PDA is `["escrow", buyer]` for
 *    `agents.primary_account_id`, and two agents that share that account share
 *    the escrow, the balance and the sequence window. Any wider key would issue
 *    the same seq twice, and the second voucher of each pair would die on chain
 *    on the chain's own sequence rule after the money was already held.
 *  - **`payment_intents.voucher_seq` is unique per account, not globally.**
 *    Buyer A's seq 5 and buyer B's seq 5 are different vouchers. The old
 *    `voucher_nonce` index was global because a nonce was globally unique; this
 *    one cannot be.
 *  - **the rail-B insert trigger now accepts either.** Rows written before this
 *    migration carry a nonce and no seq, and they must stay insertable and
 *    updatable — the argument `AddVoucherNonce1755300000000` makes at length
 *    about why the rule is a trigger on INSERT rather than a CHECK.
 */
export class BuyerEscrowsAndVoucherSeq1759100000000 implements MigrationInterface {
  name = 'BuyerEscrowsAndVoucherSeq1759100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "buyer_escrows" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1,
        "organization_id" uuid NOT NULL,
        "account_id" character varying(256) NOT NULL,
        "asset_id" character varying(256) NOT NULL,
        "escrow_pda" character varying(64) NOT NULL,
        "escrow_token_account" character varying(64) NOT NULL,
        "next_seq" bigint NOT NULL DEFAULT 1,
        "opened_tx_ref" character varying(256),
        "opened_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "pk_buyer_escrows" PRIMARY KEY ("id"),
        CONSTRAINT "chk_buyer_escrows_next_seq_positive" CHECK ("next_seq" >= 1)
      )
    `);

    // The identity of an escrow is the ACCOUNT, and nothing else is part of it.
    // Not the organization, not the agent, and NOT the asset: the chain derives
    // `["escrow", buyer]` from this pubkey alone, that one PDA carries one
    // `seq_high` and one `[u64; 128]` bitmap, and its token account is
    // `ATA(escrow, config.stake_mint)` for the single mint `Config` fixes. There
    // is no per-asset escrow on chain and no per-asset sequence space, so a key
    // of `(account_id, asset_id)` would permit two rows modelling one PDA — two
    // allocators in front of one counter. `allocateSeq`'s `UPDATE` would then
    // match both, advance both, and return whichever row Postgres produced
    // first, so a buyer could sign a voucher naming one row's escrow PDA with a
    // `seq` taken from the other row's counter.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_buyer_escrows_account"
        ON "buyer_escrows" ("account_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_buyer_escrows_organization_id" ON "buyer_escrows" ("organization_id")
    `);

    // `next_seq` only ever goes up. Without this, a restore-from-backup that
    // lowered it would re-issue live sequence numbers silently.
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
    await queryRunner.query(`
      CREATE TRIGGER trg_buyer_escrows_seq_monotonic
        BEFORE UPDATE OF "next_seq" ON "buyer_escrows"
        FOR EACH ROW EXECUTE FUNCTION assert_buyer_escrow_seq_monotonic()
    `);

    await queryRunner.query(`ALTER TABLE "payment_intents" ADD COLUMN "voucher_seq" bigint NULL`);
    await queryRunner.query(`
      ALTER TABLE "payment_intents" ADD CONSTRAINT "chk_payment_intents_rail_a_has_no_seq" CHECK (
        "rail" = 'RAIL_B_VOUCHER' OR "voucher_seq" IS NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_payment_intents_account_voucher_seq"
        ON "payment_intents" ("agent_account", "voucher_seq")
        WHERE "voucher_seq" IS NOT NULL
    `);
    // The oldest-pending query reads this index and nothing else.
    await queryRunner.query(`
      CREATE INDEX "idx_payment_intents_account_seq_open"
        ON "payment_intents" ("agent_account", "voucher_seq")
        WHERE "voucher_seq" IS NOT NULL AND "hold_released_at" IS NULL
    `);

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
    await queryRunner.query(`
      CREATE TRIGGER trg_payment_intents_voucher_seq_immutable
        BEFORE UPDATE OF "voucher_seq" ON "payment_intents"
        FOR EACH ROW EXECUTE FUNCTION assert_voucher_seq_is_immutable()
    `);

    // Rail B must carry ONE of the two. Replaces the nonce-only rule in place:
    // the trigger keeps its name and its BEFORE INSERT timing, and only the
    // predicate widens, so rows written before voucher v2 stay legal.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_rail_b_intent_has_voucher_nonce()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.rail = 'RAIL_B_VOUCHER'
           AND NEW.voucher_nonce IS NULL
           AND NEW.voucher_seq IS NULL THEN
          RAISE EXCEPTION
            'a RAIL_B_VOUCHER payment intent must record the voucher seq (v2) or nonce (v1) it was authorised by'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_rail_b_intent_has_voucher_nonce()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.rail = 'RAIL_B_VOUCHER' AND NEW.voucher_nonce IS NULL THEN
          RAISE EXCEPTION
            'a RAIL_B_VOUCHER payment intent must record the voucher nonce it was authorised by'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_payment_intents_voucher_seq_immutable" ON "payment_intents"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS assert_voucher_seq_is_immutable()`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_account_seq_open"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_payment_intents_account_voucher_seq"`);
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "chk_payment_intents_rail_a_has_no_seq"`,
    );
    await queryRunner.query(`ALTER TABLE "payment_intents" DROP COLUMN IF EXISTS "voucher_seq"`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_buyer_escrows_seq_monotonic" ON "buyer_escrows"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS assert_buyer_escrow_seq_monotonic()`);
    await queryRunner.query(`DROP TABLE IF EXISTS "buyer_escrows"`);
  }
}
