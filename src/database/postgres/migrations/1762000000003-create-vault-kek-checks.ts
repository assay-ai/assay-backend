import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A key-check value per vault KEK id: HMAC-SHA256(KEK, "assay/kek-check/v1"),
 * truncated to 16 bytes. Written the first time a KEK id is seen and compared at
 * every boot, so a key id re-pointed at different bytes fails the boot (naming
 * the id) instead of failing every decryption later. The value does not allow
 * recovering the key.
 */
export class CreateVaultKekChecks1762000000003 implements MigrationInterface {
  name = 'CreateVaultKekChecks1762000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "vault_kek_checks" (
        "kek_id"     varchar(64)  NOT NULL,
        "kcv"        bytea        NOT NULL,
        "created_at" timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_vault_kek_checks" PRIMARY KEY ("kek_id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "vault_kek_checks"`);
  }
}
