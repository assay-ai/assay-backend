import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The durable half of voucher replay protection.
 *
 * Hand-written, like the two migrations before it, because neither of the two
 * things it exists for can be expressed as an entity decorator:
 *
 *  - a **globally unique** index on `voucher_nonce`, which is the guarantee
 *    that a voucher is spendable once. Redis sits in front of it as a fast
 *    path, and *"flushing Redis must never enable a double spend"* — so
 *    this index has to reject the replay entirely on its own;
 *  - a **CHECK tying the nonce to the rail**, so that a rail-B intent without a
 *    spent nonce cannot exist.
 */
export class AddVoucherNonce1755300000000 implements MigrationInterface {
  name = 'AddVoucherNonce1755300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ADD COLUMN "voucher_nonce" character varying(64) NULL`,
    );

    // The rule has two directions, and they need two different mechanisms —
    // which is worth explaining, because a single CHECK stating both is the
    // obvious implementation and it is wrong.
    //
    // **Rail A must not carry a nonce.** A CHECK, valid immediately: rail A's
    // replay guard is on-chain, and a second guard claiming the same
    // authorization would mean neither is authoritative. No existing row can
    // violate it, because until this migration the column did not exist.
    await queryRunner.query(`
      ALTER TABLE "payment_intents" ADD CONSTRAINT "chk_payment_intents_rail_a_has_no_nonce" CHECK (
        "rail" = 'RAIL_B_VOUCHER' OR "voucher_nonce" IS NULL
      )
    `);

    // **Rail B must carry one.** A trigger on INSERT, not a CHECK, and the
    // difference is load bearing.
    //
    // A CHECK is re-evaluated on every UPDATE of the row, so it would apply
    // retroactively to rail-B intents created before this migration, when there
    // was no voucher path and no nonce to record. Those rows would become
    // *unmodifiable*: the expiry sweep could not move one to `EXPIRED`, and its
    // ledger hold would sit open until the 24-hour backstop. A guard against
    // writing a bad row that strands an agent's money is not a guard.
    //
    // `NOT VALID` does not help — Postgres skips the scan of existing rows but
    // still enforces the constraint on every subsequent update of them, which
    // is exactly the case that hurts. Backfilling is worse still: it would mean
    // inventing a spent authorization for a payment nobody authorised that way.
    //
    // Firing only on INSERT says what is actually meant: from here on, an
    // intent cannot come into existence on rail B without a nonce. It is the
    // same technique as the append-only trigger in `CreateLedger…`.
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

    await queryRunner.query(`
      CREATE TRIGGER trg_payment_intents_rail_b_has_nonce
        BEFORE INSERT ON "payment_intents"
        FOR EACH ROW EXECUTE FUNCTION assert_rail_b_intent_has_voucher_nonce()
    `);

    // **A recorded nonce can never change.**
    //
    // Without this, the durable guarantee is one UPDATE away from being erased.
    // The index above is partial (`WHERE voucher_nonce IS NOT NULL`), so
    // `UPDATE payment_intents SET voucher_nonce = NULL` drops the row out of it
    // and returns a spent voucher to circulation — and neither guard above
    // stops that: the INSERT trigger does not fire on UPDATE, and the rail-A
    // CHECK is vacuously true for every rail-B row whatever the nonce is.
    //
    // Nothing in the codebase does this today. The plausible future one is a
    // retention or PII-scrub job — 72-hour body retention is already promised —
    // quietly nulling columns on aged intents. `BEFORE UPDATE OF` fires only
    // when the column is in the SET list, so an ordinary status transition
    // never reaches it.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_voucher_nonce_is_immutable()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.voucher_nonce IS DISTINCT FROM OLD.voucher_nonce THEN
          RAISE EXCEPTION
            'payment_intents.voucher_nonce is immutable; changing it returns a spent voucher to circulation'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_payment_intents_voucher_nonce_immutable
        BEFORE UPDATE OF "voucher_nonce" ON "payment_intents"
        FOR EACH ROW EXECUTE FUNCTION assert_voucher_nonce_is_immutable()
    `);

    // Partial, because a rail-A intent has no nonce and any number of those may
    // coexist. Deliberately NOT scoped to `organization_id` — every other index
    // on this table is, and this one must not be: the same signed voucher
    // presented under two organizations is the same voucher, spent twice.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_payment_intents_voucher_nonce"
        ON "payment_intents" ("voucher_nonce")
        WHERE "voucher_nonce" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_voucher_nonce"`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_payment_intents_voucher_nonce_immutable" ON "payment_intents"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS assert_voucher_nonce_is_immutable()`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_payment_intents_rail_b_has_nonce" ON "payment_intents"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS assert_rail_b_intent_has_voucher_nonce()`);
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "chk_payment_intents_rail_a_has_no_nonce"`,
    );
    await queryRunner.query(`ALTER TABLE "payment_intents" DROP COLUMN IF EXISTS "voucher_nonce"`);
  }
}
