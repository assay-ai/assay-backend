import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `buyer_escrows.escrow_pda` and `escrow_token_account` hold CAIP-10 account
 * ids, not bare base58 addresses, and `varchar(64)` cannot fit one.
 *
 * A Solana CAIP-10 account id is 84 characters —
 * `solana:` (7) + the 32-character genesis prefix + `:` + a 44-character
 * base58 address:
 *
 *     solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:AaGL55ZWYZmrpU1hkgz88v7caZBXDvzA1L4yVk34QXR1
 *
 * `EscrowOpenerPort.open` returns both fields typed `AccountId`,
 * `DepositService` writes them through unchanged, and every reader —
 * `EscrowBalanceReaderPort`, `EscrowAccountService` — types them `AccountId`
 * too. The two columns were the only place that said otherwise: sized 64 for a
 * bare address while their siblings `account_id` and `asset_id` are already
 * 256 for exactly this reason.
 *
 * **The effect was that no deposit could succeed on Solana at all.**
 * `POST /deposits` opens the escrow on chain, then writes the mirror row, and
 * the write failed with `value too long for type character varying(64)` — a
 * 500 that names no column and arrives *after* an escrow has been opened.
 * `devnet:acceptance` step 5 is where it surfaced.
 *
 * Nothing has to be repaired: no row was ever written, because no insert could
 * ever have fitted.
 *
 * No unit or integration test could have caught it. Both suites write through
 * repositories backed by in-memory fakes or by contexts whose migration lists
 * build the same columns; a `varchar` length is a property of Postgres and
 * only a real insert of a real address exercises it. Same shape as the CHECK
 * that `rail-a-hold-never-commits` records.
 */
export class WidenBuyerEscrowAddresses1759200000000 implements MigrationInterface {
  name = 'WidenBuyerEscrowAddresses1759200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "buyer_escrows"
        ALTER COLUMN "escrow_pda" TYPE character varying(256),
        ALTER COLUMN "escrow_token_account" TYPE character varying(256)
    `);

    await queryRunner.query(
      `COMMENT ON COLUMN "buyer_escrows"."escrow_pda" IS ` +
        `'CAIP-10. ["escrow", buyer] — a voucher''s pay_to.'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "buyer_escrows"."escrow_token_account" IS ` +
        `'CAIP-10. ATA(escrow_pda, stake_mint) — where the balance actually sits.'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Narrowing back would refuse every row this migration made writable, so
    // the down path is only safe on an empty table — which is the state it was
    // in when the widening happened.
    await queryRunner.query(`
      ALTER TABLE "buyer_escrows"
        ALTER COLUMN "escrow_pda" TYPE character varying(64),
        ALTER COLUMN "escrow_token_account" TYPE character varying(64)
    `);
  }
}
