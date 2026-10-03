import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Every signature, key and account column widened to 256, and the
 * two escrow columns renamed to what they will actually hold.
 *
 * ## The widths, and the three that are easy to miss
 *
 * The obvious list is `payment_intents.voucher_signature`, the three
 * `slash_proposals` signatures, `verifier_signing_keys.chain_address`, the two
 * `buyer_escrows` columns and `agents.primary_account_id`. Three more have the
 * identical defect and are included here:
 *
 * - `verifier_signing_keys.public_key varchar(64)` — a raw ed25519 key as 64
 *   lowercase hex characters. Exactly 64, zero headroom. A secp256k1 key is 130
 *   hex characters uncompressed.
 * - `verifier_signing_log.public_key varchar(64)` — the same value, same defect.
 * - `verifier_signing_log.signature varchar(128)` — a 64-byte signature as 128
 *   hex characters. Exactly 128, zero headroom. A secp256k1 signature is 130.
 *
 * Leaving those three would mean the *first* secp256k1 signature this platform
 * ever produced would fail to be journalled — after it had been produced, which
 * is the one moment the journal exists for.
 *
 * ## And one that needs widening for a less obvious reason
 *
 * `agents.primary_account_id varchar(160)` is not an EVM problem. This
 * codebase's own CAIP-10 grammar (`caip.types.ts`) permits 8 + 1 + 32 + 1 + 128
 * = **170** characters, so a legal account id that `isAccountId()` accepts is
 * already rejected by Postgres today, on Solana, with `value too long`. Every
 * other CAIP-10 column in the schema is 256; this was the outlier.
 *
 * ## The rename is the point
 *
 * `escrow_pda` and `escrow_token_account` are base58 `varchar(64)` holding a
 * derived PDA and its ATA. On EVM both are the escrow contract's own address —
 * one contract holds every buyer, and there is no per-buyer account to derive.
 * The columns stop being "a derived PDA" and become "the on-chain thing that
 * holds this buyer's money", which is true on both chains. Widening without
 * renaming would leave the name `escrow_pda` on a column holding an `0x`
 * address, which is how the next reader writes a base58 decode against it.
 *
 * ## The two narrow columns deliberately left narrow
 *
 * A width sweep that says nothing about what it skipped is indistinguishable
 * from one that did not look, so both exclusions are named:
 *
 * - `payment_intents.payload_sha256 varchar(64)` — a sha256 digest is 64 hex
 *   characters on every chain there will ever be. 64 is exact, not tight.
 * - `payment_intents.voucher_nonce varchar(64)` — the only narrow
 *   chain-adjacent varchar left in the schema, and it is not a chain value at
 *   all. It is a platform-minted one-time token from voucher v1
 *   (`AddVoucherNonce1755300000000`): never signed by a wallet, never rendered
 *   in a chain's notation, never read off an RPC, and superseded by
 *   `voucher_seq` — no caller writes it any more
 *   (`payment-intent.service.ts`). Its width is decided by this platform's own
 *   minting path, not by secp256k1, so widening it would only make the unique
 *   index wider for nothing.
 *
 * ## No CHECK is added here
 *
 * `buyer_escrows` has live rows whose values are bare base58, not CAIP-10. A
 * grammar CHECK would refuse a table that is already in that state. The
 * canonicalising write path is a separate change and the backfill belongs with
 * the code that changes it, not in a width migration.
 */
export class WidenSignatureAndAccountColumns1759300000000 implements MigrationInterface {
  name = 'WidenSignatureAndAccountColumns1759300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Widening a varchar is a catalogue-only change in Postgres — no table
    // rewrite, no exclusive lock held for the length of the table. Narrowing it
    // back in `down()` is NOT: it rescans. That asymmetry is why `down()` below
    // is honest about what it can and cannot restore.
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        ALTER COLUMN "voucher_signature" TYPE character varying(256)
    `);

    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ALTER COLUMN "chain_proposal_signature" TYPE character varying(256),
        ALTER COLUMN "execution_signature"      TYPE character varying(256),
        ALTER COLUMN "reversal_signature"       TYPE character varying(256)
    `);

    await queryRunner.query(`
      ALTER TABLE "verifier_signing_keys"
        ALTER COLUMN "public_key"    TYPE character varying(256),
        ALTER COLUMN "chain_address" TYPE character varying(256)
    `);

    await queryRunner.query(`
      ALTER TABLE "verifier_signing_log"
        ALTER COLUMN "public_key" TYPE character varying(256),
        ALTER COLUMN "signature"  TYPE character varying(256)
    `);

    await queryRunner.query(`
      ALTER TABLE "agents"
        ALTER COLUMN "primary_account_id" TYPE character varying(256),
        ALTER COLUMN "chain_id"           TYPE character varying(128)
    `);

    await queryRunner.query(`
      ALTER TABLE "buyer_escrows"
        RENAME COLUMN "escrow_pda" TO "escrow_account_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "buyer_escrows"
        RENAME COLUMN "escrow_token_account" TO "escrow_asset_account_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "buyer_escrows"
        ALTER COLUMN "escrow_account_id"       TYPE character varying(256),
        ALTER COLUMN "escrow_asset_account_id" TYPE character varying(256)
    `);

    // `1759100000002-voucher-redemption-fields` documented this column as
    // "Base58 ed25519" — true when Solana was the only chain, and a direct
    // contradiction of the width this migration just gave it. A comment that
    // contradicts its column is worse than none: it is the base58 decode the
    // rename above exists to prevent, one table over.
    await queryRunner.query(
      `COMMENT ON COLUMN "payment_intents"."voucher_signature" IS ` +
        `'The buyer''s signature over the voucher''s signed bytes, in the chain''s own ` +
        `encoding — base58 ed25519 on Solana, 0x-hex secp256k1 on eip155. Replayed verbatim ` +
        `by the settlement program.'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "verifier_signing_keys"."chain_address" IS ` +
        `'CAIP-10. The key in the chain''s own notation — base58 on Solana, 0x on eip155.'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "buyer_escrows"."escrow_account_id" IS ` +
        `'CAIP-10. The on-chain thing holding this buyer''s money: the ["escrow", buyer] PDA on ` +
        `Solana, the escrow contract itself on eip155.'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "buyer_escrows"."escrow_asset_account_id" IS ` +
        `'CAIP-10. Where the balance actually sits: the PDA''s ATA on Solana, the escrow ` +
        `contract itself on eip155.'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The comments go first, and they have to: `RENAME COLUMN` carries a
    // column's comment across with it, so a `down()` that only renamed would
    // leave `escrow_pda` describing "the escrow contract itself on eip155" —
    // the exact confusion the rename exists to prevent, pointing the other way.
    // These three columns had no comment before this migration, so `IS NULL`
    // is the real prior state and not merely a blanking.
    await queryRunner.query(`COMMENT ON COLUMN "buyer_escrows"."escrow_asset_account_id" IS NULL`);
    await queryRunner.query(`COMMENT ON COLUMN "buyer_escrows"."escrow_account_id" IS NULL`);
    await queryRunner.query(`COMMENT ON COLUMN "verifier_signing_keys"."chain_address" IS NULL`);
    // NOT `IS NULL`: `voucher_signature` carried a comment before this
    // migration, set by `1759100000002-voucher-redemption-fields`. Restoring
    // the prior state here means restoring that exact text, not blanking it.
    await queryRunner.query(
      `COMMENT ON COLUMN "payment_intents"."voucher_signature" IS ` +
        `'Base58 ed25519, the buyer''s, over the 239 signed bytes. Replayed verbatim by ` +
        `redeem_voucher.'`,
    );

    // Exact inverse, in reverse order. Narrowing rescans and will FAIL if any
    // row now holds a value longer than the old width — which is correct: a
    // revert that silently truncated a signature would destroy the one thing
    // the column exists to hold. If this errors, the data has already outgrown
    // the old schema and the revert is genuinely not available.
    await queryRunner.query(
      `ALTER TABLE "buyer_escrows" ALTER COLUMN "escrow_asset_account_id" TYPE character varying(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "buyer_escrows" ALTER COLUMN "escrow_account_id" TYPE character varying(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "buyer_escrows" RENAME COLUMN "escrow_asset_account_id" TO "escrow_token_account"`,
    );
    await queryRunner.query(
      `ALTER TABLE "buyer_escrows" RENAME COLUMN "escrow_account_id" TO "escrow_pda"`,
    );

    await queryRunner.query(`
      ALTER TABLE "agents"
        ALTER COLUMN "chain_id"           TYPE character varying(64),
        ALTER COLUMN "primary_account_id" TYPE character varying(160)
    `);

    await queryRunner.query(`
      ALTER TABLE "verifier_signing_log"
        ALTER COLUMN "signature"  TYPE character varying(128),
        ALTER COLUMN "public_key" TYPE character varying(64)
    `);

    await queryRunner.query(`
      ALTER TABLE "verifier_signing_keys"
        ALTER COLUMN "chain_address" TYPE character varying(64),
        ALTER COLUMN "public_key"    TYPE character varying(64)
    `);

    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ALTER COLUMN "reversal_signature"       TYPE character varying(128),
        ALTER COLUMN "execution_signature"      TYPE character varying(128),
        ALTER COLUMN "chain_proposal_signature" TYPE character varying(128)
    `);

    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        ALTER COLUMN "voucher_signature" TYPE character varying(128)
    `);
  }
}
