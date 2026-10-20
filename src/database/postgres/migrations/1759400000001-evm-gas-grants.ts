import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The ledger behind the zero-ETH withdraw grant.
 *
 * `AssayEscrow.withdraw()` is `msg.sender`-only and pays `msg.sender`, and there
 * is no `withdrawBySig` by design — which is exactly what makes a hardware
 * wallet a sufficient upgrade later, and exactly what leaves a buyer who
 * deposited USDG and holds no ETH with no exit at all. The answer: the relayer
 * may fund the buyer's address with exactly the gas for one `withdraw` — a
 * bounded, auditable, capped transfer with its own alert, and it can never
 * become a way to move USDG.
 *
 * ## `uniq_evm_gas_grants_account` IS the bound
 *
 * Everything else in `EvmGasGrantService` — a per-grant cap, a daily cap, a
 * relayer float floor, a matured-withdrawal precondition — is a **second** line.
 * Without this index they are a rate limit on a faucet, and a faucet is a way to
 * drain the float one legitimate-looking request at a time. With it, an address
 * is funded once in the lifetime of the deployment and the caps only bound how
 * much that once may cost.
 *
 * It is deliberately **not** scoped to `organization_id`. A grant is measured
 * against an ADDRESS, and an attacker who can create organizations would
 * otherwise get one grant per organization to the same address. That is why the
 * service reads its refusal off this index rather than off a `SELECT`: an
 * organization-scoped read cannot see another tenant's row, and the index can.
 *
 * ## No soft delete
 *
 * `evm_gas_grants` extends `OrganizationScopedEntityWithoutSoftDelete`. A grant
 * is money that left the relayer; a `deleted_at` is an affordance for making it
 * disappear while the row count still looks right, and the one row that must
 * never disappear is the one that says an address has already been funded.
 *
 * ## The two CHECKs
 *
 * `chk_evm_gas_grants_account_on_chain` is what stops a Solana account id being
 * filed under an `eip155` chain. `account_id` is CAIP-10 and begins with its own
 * chain id, so `account_id LIKE chain_id || ':%'` is a total statement of "these
 * two agree" that needs no parsing — and it is the constraint that makes the
 * unique index above mean what it says, since two spellings of one address under
 * two chain ids would be two rows.
 *
 * `chk_evm_gas_grants_wei_positive` refuses a zero grant. A row saying "we sent
 * nothing" would consume the once-ever budget for an address that never got any
 * gas, which is the worst of both.
 */
export class EvmGasGrants1759400000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "evm_gas_grants" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1,
        "organization_id" uuid NOT NULL,
        "chain_id" varchar(64) NOT NULL,
        "account_id" varchar(256) NOT NULL,
        "wei" numeric(78,0) NOT NULL,
        "transaction_hash" varchar(66) NOT NULL,
        CONSTRAINT "pk_evm_gas_grants" PRIMARY KEY ("id"),
        CONSTRAINT "chk_evm_gas_grants_account_on_chain" CHECK ("account_id" LIKE "chain_id" || ':%'),
        CONSTRAINT "chk_evm_gas_grants_wei_positive" CHECK ("wei" > 0)
      )
    `);

    // ONE grant per address, EVER. See the class comment: this index is the
    // bound, and the caps are the second line.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uniq_evm_gas_grants_account" ON "evm_gas_grants" ("account_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uniq_evm_gas_grants_transaction" ON "evm_gas_grants" ("transaction_hash")`,
    );
    // The daily-cap read is `sum(wei) where created_at > now() - 24h`, so this
    // index is the one that keeps it from being a sequential scan over every
    // grant the deployment has ever made.
    await queryRunner.query(
      `CREATE INDEX "idx_evm_gas_grants_created" ON "evm_gas_grants" ("created_at")`,
    );
    // `OrganizationScopedEntity` declares `@Index()` on the scope column and
    // TypeORM would name it `IDX_<hash>`; naming it here keeps the schema
    // readable and matches what the other business tables carry.
    await queryRunner.query(
      `CREATE INDEX "idx_evm_gas_grants_organization" ON "evm_gas_grants" ("organization_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // `DROP TABLE` takes the indexes and constraints with it; they are dropped
    // explicitly first so that a partial `up` — one that created the table and
    // died on an index — still reverts cleanly.
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_evm_gas_grants_organization"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_evm_gas_grants_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uniq_evm_gas_grants_transaction"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uniq_evm_gas_grants_account"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "evm_gas_grants"`);
  }
}
