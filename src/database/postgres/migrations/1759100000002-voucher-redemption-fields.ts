import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The three voucher fields the redemption job cannot reconstruct.
 *
 * `redeem_voucher` proves an ed25519 signature over 239 bytes, and the program
 * recomputes those bytes from the instruction's own nine arguments. So the job
 * that submits a redemption, minutes after the call was served, has to reproduce
 * every one of the nine exactly. Six of them were already on the row —
 * `agent_account`, `provider_account`, `price_amount`, `request_hash`,
 * `voucher_seq`, and `expires_at`, which `VoucherService.record` writes as
 * `voucher.expiresAt * 1000` and nothing else ever updates. The seventh,
 * `pay_to`, is the escrow PDA and is derived from the payer.
 *
 * The three here had nowhere to live, and without them the redemption would
 * build 239 bytes the buyer never signed — refused on chain with
 * `MissingBuyerSignature`, after the call had already been served and the
 * money held. That is the failure this migration exists to make impossible.
 *
 * All nullable: rail A has no voucher at all, and rail-B rows written before
 * this migration have no signature to backfill from. A `chk` pairing them is
 * deliberately **not** added — such rows exist, and a constraint that refuses
 * them would refuse a table that is already in that state.
 */
export class VoucherRedemptionFields1759100000002 implements MigrationInterface {
  name = 'VoucherRedemptionFields1759100000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        ADD COLUMN "voucher_signature"     character varying(128) NULL,
        ADD COLUMN "voucher_resource_hash" character varying(71)  NULL,
        ADD COLUMN "voucher_issued_at"     bigint                 NULL
    `);

    await queryRunner.query(
      `COMMENT ON COLUMN "payment_intents"."voucher_signature" IS ` +
        `'Base58 ed25519, the buyer''s, over the 239 signed bytes. Replayed verbatim by redeem_voucher.'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "payment_intents"."voucher_resource_hash" IS ` +
        `'sha256: plus 64 hex — offset 152 of the signed bytes, and not derivable from any other column.'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "payment_intents"."voucher_issued_at" IS ` +
        `'Unix seconds, offset 223. Also what the redemption deadline (2,220s) is counted from.'`,
    );

    // The redemption job's own query: rail-B, settled, hold still open,
    // ordered by (agent_account, voucher_seq) so each buyer's holds go up in
    // sequence. `idx_payment_intents_account_seq_open` already covers
    // (agent_account, voucher_seq) WHERE hold_released_at IS NULL, so the
    // ordering is free; this narrows it to the statuses the job acts on.
    await queryRunner.query(`
      CREATE INDEX "idx_payment_intents_awaiting_redemption"
        ON "payment_intents" ("asset_id", "agent_account", "voucher_seq")
        WHERE "rail" = 'RAIL_B_VOUCHER'
          AND "status" = 'SETTLED'
          AND "hold_released_at" IS NULL
          AND "voucher_seq" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_awaiting_redemption"`);
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        DROP COLUMN IF EXISTS "voucher_signature",
        DROP COLUMN IF EXISTS "voucher_resource_hash",
        DROP COLUMN IF EXISTS "voucher_issued_at"
    `);
  }
}
