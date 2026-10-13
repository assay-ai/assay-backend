import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops `evm_chain_states.upgraded`. The backend now assumes the upgraded
 * contracts (owner decision on audit E-3): there is no old-versus-new Config
 * detection left to cache.
 */
export class EvmChainStateDropUpgraded1760000000000 implements MigrationInterface {
  name = 'EvmChainStateDropUpgraded1760000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "evm_chain_states" DROP COLUMN "upgraded"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "evm_chain_states" ADD COLUMN "upgraded" boolean`);
  }
}
