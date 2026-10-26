import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `evm_chain_states.params_changed_at`: when the chain-state indexer last read
 * a config-change event (`ConfigUpdated`, `SlashDelaySet`, `CollectHoldSet`,
 * `ArbiterSet`). Every process already polls this table; a new stamp makes it
 * re-read the on-chain params at once rather than at the next 5-minute refresh.
 */
export class EvmChainStateParamsChanged1762400000120 implements MigrationInterface {
  name = 'EvmChainStateParamsChanged1762400000120';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evm_chain_states" ADD COLUMN IF NOT EXISTS "params_changed_at" timestamptz NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evm_chain_states" DROP COLUMN IF EXISTS "params_changed_at"`,
    );
  }
}
