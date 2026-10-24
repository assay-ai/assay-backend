import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `evm_chain_states.slash_backfill_cursor_block` and `slash_backfill_done_at`
 * (review 2026-10-24 wave 3 N-3): how far the slash watcher has back-filled
 * `evm_slash_records` from the chain's `SlashProposed` events that its own
 * cursor had already passed when the table was created. Without it, records
 * proposed before the table existed would never be reaped or attributed.
 */
export class EvmSlashRecordsBackfill1762400000100 implements MigrationInterface {
  name = 'EvmSlashRecordsBackfill1762400000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evm_chain_states"
         ADD COLUMN "slash_backfill_cursor_block" bigint,
         ADD COLUMN "slash_backfill_done_at" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evm_chain_states"
         DROP COLUMN "slash_backfill_done_at",
         DROP COLUMN "slash_backfill_cursor_block"`,
    );
  }
}
