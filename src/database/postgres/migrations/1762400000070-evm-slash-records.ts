import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `evm_slash_records`: every `SlashProposed` record the slash watcher saw on
 * an EVM chain, this platform's and anybody else's (review 2026-10-24 wave 2
 * M-2).
 *
 * Since D-26 a standing record reserves the provider's stake and can halt its
 * payments. A stolen verifier key can therefore halt payments in one block,
 * and revoking the key does not release what it signed. The revoked-verifier
 * reaper reads this table to release (`expireSlash`) every standing record of
 * a key that can no longer sign, and the redeemer reads it so a provider short
 * of free stake only because of such records is not blamed for it.
 */
export class EvmSlashRecords1762400000070 implements MigrationInterface {
  name = 'EvmSlashRecords1762400000070';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "evm_slash_records" (
        "id"                   uuid          NOT NULL DEFAULT gen_random_uuid(),
        "chain_id"             varchar(64)   NOT NULL,
        "request_id"           varchar(64)   NOT NULL,
        "provider"             varchar(42)   NOT NULL,
        "verifier"             varchar(42)   NOT NULL,
        "reserved"             numeric(40,0) NOT NULL,
        "executable_at"        timestamptz,
        "foreign"              boolean       NOT NULL DEFAULT false,
        "verifier_unavailable" boolean       NOT NULL DEFAULT false,
        "block_number"         bigint,
        "transaction_hash"     varchar(66),
        "closed_at"            timestamptz,
        "reap_attempts"        integer       NOT NULL DEFAULT 0,
        "reap_last_error"      varchar(128),
        "created_at"           timestamptz   NOT NULL DEFAULT now(),
        "updated_at"           timestamptz   NOT NULL DEFAULT now(),
        "version"              integer       NOT NULL DEFAULT 1,
        CONSTRAINT "pk_evm_slash_records" PRIMARY KEY ("id"),
        CONSTRAINT "chk_evm_slash_records_chain" CHECK ("chain_id" LIKE 'eip155:%'),
        CONSTRAINT "chk_evm_slash_records_request" CHECK ("request_id" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "chk_evm_slash_records_provider" CHECK ("provider" ~ '^0x[0-9a-f]{40}$'),
        CONSTRAINT "chk_evm_slash_records_verifier" CHECK ("verifier" ~ '^0x[0-9a-f]{40}$')
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_evm_slash_records_chain_request"
         ON "evm_slash_records" ("chain_id", "request_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_evm_slash_records_standing_verifier"
         ON "evm_slash_records" ("chain_id", "verifier") WHERE "closed_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_evm_slash_records_standing_provider"
         ON "evm_slash_records" ("chain_id", "provider") WHERE "closed_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "evm_slash_records"`);
  }
}
