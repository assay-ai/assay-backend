import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The EVM chain-state cache: each chain's pause flag and dispute-upgrade terms
 * (`evm_chain_states`) and the on-chain blocklist (`evm_blocked_addresses`),
 * indexed from `AssayConfig`'s `PauseToggled` and `BlockedSet` events by
 * `EvmChainStateIndexer` and reconciled against `paused()` / `blocked()` every
 * few minutes. A cache: the contracts stay the enforcer.
 */
export class EvmChainState1759900000001 implements MigrationInterface {
  name = 'EvmChainState1759900000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "evm_chain_states" (
        "id"                  uuid          NOT NULL DEFAULT gen_random_uuid(),
        "chain_id"            varchar(64)   NOT NULL,
        "paused"              boolean       NOT NULL DEFAULT false,
        "upgraded"            boolean,
        "arbiter"             varchar(42),
        "slash_delay_seconds" integer,
        "cursor_block"        bigint,
        "head_block"          bigint,
        "indexed_at"          timestamptz,
        "caught_up_at"        timestamptz,
        "reconciled_at"       timestamptz,
        "last_error"          varchar(256),
        "created_at"          timestamptz   NOT NULL DEFAULT now(),
        "updated_at"          timestamptz   NOT NULL DEFAULT now(),
        "version"             integer       NOT NULL DEFAULT 1,
        CONSTRAINT "pk_evm_chain_states" PRIMARY KEY ("id"),
        CONSTRAINT "chk_evm_chain_states_chain" CHECK ("chain_id" LIKE 'eip155:%'),
        CONSTRAINT "chk_evm_chain_states_arbiter" CHECK ("arbiter" IS NULL OR "arbiter" ~ '^0x[0-9a-f]{40}$'),
        CONSTRAINT "chk_evm_chain_states_cursor" CHECK ("cursor_block" IS NULL OR "cursor_block" >= 0)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_evm_chain_states_chain" ON "evm_chain_states" ("chain_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "evm_blocked_addresses" (
        "id"               uuid          NOT NULL DEFAULT gen_random_uuid(),
        "chain_id"         varchar(64)   NOT NULL,
        "address"          varchar(42)   NOT NULL,
        "blocked"          boolean       NOT NULL,
        "set_by"           varchar(42),
        "block_number"     bigint,
        "log_index"        integer,
        "transaction_hash" varchar(66),
        "reconciled_at"    timestamptz,
        "created_at"       timestamptz   NOT NULL DEFAULT now(),
        "updated_at"       timestamptz   NOT NULL DEFAULT now(),
        "version"          integer       NOT NULL DEFAULT 1,
        CONSTRAINT "pk_evm_blocked_addresses" PRIMARY KEY ("id"),
        CONSTRAINT "chk_evm_blocked_addresses_address" CHECK ("address" ~ '^0x[0-9a-f]{40}$')
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_evm_blocked_addresses_chain_address"
         ON "evm_blocked_addresses" ("chain_id", "address")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "evm_blocked_addresses"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "evm_chain_states"`);
  }
}
