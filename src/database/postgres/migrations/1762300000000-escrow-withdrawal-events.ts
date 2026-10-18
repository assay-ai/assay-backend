import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The buyer's withdrawal history (B7): every `WithdrawRequested` and
 * `EscrowWithdrawn` the escrow emitted, as `EvmEscrowWithdrawalIndexer` read
 * them past the confirmation depth, and that indexer's own cursor.
 *
 * Read-side bookkeeping only. Nothing that moves money, gates a call or
 * reconciles reads this table: the chain stays the record of the balance.
 * One row per log (`chain_id`, `transaction_hash`, `log_index`), so a re-read
 * range inserts nothing twice.
 */
export class EscrowWithdrawalEvents1762300000000 implements MigrationInterface {
  name = 'EscrowWithdrawalEvents1762300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "escrow_withdrawal_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1,
        "chain_id" varchar(64) NOT NULL,
        "buyer_address" varchar(42) NOT NULL,
        "kind" varchar(16) NOT NULL,
        "amount" numeric(78,0) NOT NULL,
        "requested" numeric(78,0),
        "available_at" timestamptz,
        "block_number" bigint NOT NULL,
        "log_index" integer NOT NULL,
        "transaction_hash" varchar(66) NOT NULL,
        "block_time" timestamptz NOT NULL,
        CONSTRAINT "pk_escrow_withdrawal_events" PRIMARY KEY ("id"),
        CONSTRAINT "chk_escrow_withdrawal_events_kind"
          CHECK ("kind" IN ('REQUESTED', 'CANCELLED', 'WITHDRAWN')),
        CONSTRAINT "chk_escrow_withdrawal_events_amount" CHECK ("amount" >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_escrow_withdrawal_events_log"
        ON "escrow_withdrawal_events" ("chain_id", "transaction_hash", "log_index")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_escrow_withdrawal_events_buyer"
        ON "escrow_withdrawal_events" ("chain_id", "buyer_address", "block_number", "log_index")
    `);
    await queryRunner.query(
      `ALTER TABLE "evm_chain_states" ADD COLUMN "withdrawal_cursor_block" bigint`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "evm_chain_states" DROP COLUMN "withdrawal_cursor_block"`);
    await queryRunner.query(`DROP TABLE "escrow_withdrawal_events"`);
  }
}
