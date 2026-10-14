import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `evm_chain_states.slash_watch_cursor_block` (review S-4): the last block the
 * forged-slash watcher (`EvmSlashProposalWatcher`, review H-1) has read on the
 * chain. It was in the cache Redis, which may evict it, and a lost cursor
 * re-read only a fixed lookback, so a forged `SlashProposed` before it was
 * skipped for good. Kept beside the chain-state indexer's own cursor.
 */
export class EvmSlashWatchCursor1760200000001 implements MigrationInterface {
  name = 'EvmSlashWatchCursor1760200000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evm_chain_states" ADD COLUMN "slash_watch_cursor_block" bigint`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evm_chain_states" DROP COLUMN "slash_watch_cursor_block"`,
    );
  }
}
