import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deposit intents.
 *
 * Hand-written, like `CreatePaymentIntents1755200000000` before it: the CHECK
 * constraints below cannot be expressed as entity decorators, and a generated
 * migration would silently omit them.
 */
export class CreateDepositIntents1755400000000 implements MigrationInterface {
  name = 'CreateDepositIntents1755400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE "deposit_intents" (
        "id"               uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"       TIMESTAMP     NOT NULL DEFAULT now(),
        "updated_at"       TIMESTAMP     NOT NULL DEFAULT now(),
        "version"          integer       NOT NULL DEFAULT 1,
        "organization_id"  uuid          NOT NULL,
        "status"           character varying(16)  NOT NULL,
        "status_reason"    character varying(256) NULL,
        "agent_id"         uuid          NOT NULL,
        "agent_account"    character varying(256) NOT NULL,
        "asset_id"         character varying(256) NOT NULL,
        "decimals"         integer       NOT NULL,
        "requested_amount" numeric(78,0) NOT NULL,
        "settled_amount"   numeric(78,0) NULL,
        "chain_id"         character varying(128) NOT NULL,
        "chain_tx_ref"     character varying(256) NULL,
        "expires_at"       TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "pk_deposit_intents" PRIMARY KEY ("id"),
        CONSTRAINT "chk_deposit_intents_status" CHECK ("status" IN (
          'CREATED', 'SETTLING', 'SETTLED', 'FAILED', 'EXPIRED'
        )),
        CONSTRAINT "chk_deposit_intents_amounts_unsigned" CHECK (
          "requested_amount" >= 0 AND ("settled_amount" IS NULL OR "settled_amount" >= 0)
        ),
        -- A settlement transaction reference without a settled amount, or the
        -- reverse, describes a settlement that is only half recorded.
        CONSTRAINT "chk_deposit_intents_settlement_pair" CHECK (
          ("settled_amount" IS NULL) = ("chain_tx_ref" IS NULL)
        )
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_deposit_intents_organization_id" ON "deposit_intents" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_deposit_intents_agent" ON "deposit_intents" ("organization_id", "agent_id")`,
    );

    // Drives the expiry sweep — leading with `status` keeps the scan to
    // `CREATED`, the only expirable status, same reasoning as
    // `idx_payment_intents_status_expires_at`.
    await queryRunner.query(
      `CREATE INDEX "idx_deposit_intents_status_expires_at" ON "deposit_intents" ` +
        `("status", "expires_at")`,
    );

    // Drives the finality sweep (`DEPOSIT_PENDING` -> `DEPOSIT_CONFIRM` /
    // `DEPOSIT_REJECT`): every settled deposit intent has a transaction to
    // re-check, and this is how the sweep finds them without scanning the
    // whole table.
    await queryRunner.query(`
      CREATE INDEX "idx_deposit_intents_chain_tx_ref" ON "deposit_intents" ("chain_tx_ref")
        WHERE "chain_tx_ref" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "deposit_intents"`);
  }
}
