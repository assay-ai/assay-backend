import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payment intents.
 *
 * Hand-written for the same reason `CreateLedger1755100000000` was: the two
 * guarantees this table exists to provide cannot be expressed as entity
 * decorators, so a generated migration would silently omit both.
 *
 *  - the **partial unique index** on `(organization_id, agent_id,
 *    idempotency_key)`, which is what makes idempotency survive a Redis flush
 *    and two simultaneous requests on two API instances;
 *  - the **fee-split CHECK**, which makes `provider_amount + platform_fee =
 *    price_amount` a database fact rather than a code review outcome.
 */
export class CreatePaymentIntents1755200000000 implements MigrationInterface {
  name = 'CreatePaymentIntents1755200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE "payment_intents" (
        "id"                   uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"           TIMESTAMP     NOT NULL DEFAULT now(),
        "updated_at"           TIMESTAMP     NOT NULL DEFAULT now(),
        "version"              integer       NOT NULL DEFAULT 1,
        "organization_id"      uuid          NOT NULL,
        "status"               character varying(24)  NOT NULL,
        "status_reason"        character varying(256) NULL,
        "agent_id"             uuid          NOT NULL,
        "agent_account"        character varying(256) NOT NULL,
        "provider_id"          uuid          NOT NULL,
        "provider_account"     character varying(256) NOT NULL,
        "tool_id"              uuid          NOT NULL,
        "rail"                 character varying(24)  NOT NULL,
        "asset_id"             character varying(256) NOT NULL,
        "decimals"             integer       NOT NULL,
        "price_amount"         numeric(78,0) NOT NULL,
        "provider_amount"      numeric(78,0) NOT NULL,
        "platform_fee"         numeric(78,0) NOT NULL,
        "settled_amount"       numeric(78,0) NULL,
        "request_hash"         character varying(128) NOT NULL,
        "chain_id"             character varying(128) NOT NULL,
        "expires_at"           TIMESTAMP WITH TIME ZONE NOT NULL,
        "idempotency_key"      character varying(255)  NULL,
        "hold_id"              uuid          NULL,
        "hold_released_at"     TIMESTAMP WITH TIME ZONE NULL,
        "classification"       character varying(32)  NULL,
        "verification_verdict" character varying(32)  NULL,
        CONSTRAINT "pk_payment_intents" PRIMARY KEY ("id"),
        CONSTRAINT "chk_payment_intents_status" CHECK ("status" IN (
          'CREATED', 'FUNDS_SECURED', 'PROVIDER_EXECUTING', 'VERIFYING',
          'SETTLED', 'REFUNDED', 'VOIDED', 'EXPIRED'
        )),
        CONSTRAINT "chk_payment_intents_rail" CHECK (
          "rail" IN ('RAIL_A_PER_CALL', 'RAIL_B_VOUCHER')
        ),
        CONSTRAINT "chk_payment_intents_amounts_unsigned" CHECK (
          "price_amount" >= 0 AND "provider_amount" >= 0 AND "platform_fee" >= 0
          AND ("settled_amount" IS NULL OR "settled_amount" >= 0)
        ),
        -- The fee split adds up, or the row does not exist. A fee that does not
        -- come out of the price is a fee charged twice.
        CONSTRAINT "chk_payment_intents_fee_split" CHECK (
          "provider_amount" + "platform_fee" = "price_amount"
        ),
        -- A release timestamp without a hold describes money that was never
        -- reserved being given back.
        CONSTRAINT "chk_payment_intents_hold_release" CHECK (
          "hold_released_at" IS NULL OR "hold_id" IS NOT NULL
        )
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_organization_id" ON "payment_intents" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_agent" ON "payment_intents" ("organization_id", "agent_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_request_hash" ON "payment_intents" ` +
        `("organization_id", "request_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_hold_id" ON "payment_intents" ("organization_id", "hold_id")`,
    );

    // Drives the expiry sweep. Leading with `status` keeps the scan to the two
    // states that have an EXPIRED edge, which is a small slice of a table whose
    // rows are overwhelmingly terminal.
    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_status_expires_at" ON "payment_intents" ` +
        `("status", "expires_at")`,
    );

    // One intent per (agent, key). Partial, because a null key is "this agent
    // did not ask for idempotency", and any number of those may coexist —
    // a plain unique index would let exactly one of them exist per agent.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_payment_intents_idempotency_key"
        ON "payment_intents" ("organization_id", "agent_id", "idempotency_key")
        WHERE "idempotency_key" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "payment_intents"`);
  }
}
