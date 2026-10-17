import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Buyer disputes over one paid call (backlog G3.B1).
 *
 * The `disputes` table already holds every kind of challenge; a buyer's
 * dispute over a call is a row of it with `intent_id` set. The new columns:
 *
 * - `intent_id`, `verdict_id`, `binding_id`, `tool_id`, `respondent_provider_id`:
 *   the call, resolved once at filing. `respondent_provider_id` is the provider
 *   the buyer disputes — not `provider_id`, which names a provider that FILED.
 * - `evidence_snapshot`: what the decision rests on, copied at filing, because
 *   the evidence bodies are scrubbed after their retention window.
 * - `provider_response` / `provider_responded_at`: the provider's one reply.
 * - `refund_source` / `refund_state` / `refund_amount`: the money side of an
 *   upheld decision (see `CallDisputeService`).
 *
 * `uq_disputes_open_call` allows one open dispute per call. `payment_intents.
 * dispute_outcome` and `verification_records.dispute_outcome` mark the call and
 * its verdict with the decision; the quality stats read the intent's.
 */
export class CallDisputes1761800000000 implements MigrationInterface {
  name = 'CallDisputes1761800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "disputes"
        ADD COLUMN "intent_id" uuid NULL,
        ADD COLUMN "verdict_id" uuid NULL,
        ADD COLUMN "binding_id" uuid NULL,
        ADD COLUMN "tool_id" character varying(128) NULL,
        ADD COLUMN "respondent_provider_id" uuid NULL,
        ADD COLUMN "evidence_snapshot" jsonb NULL,
        ADD COLUMN "provider_response" character varying(1000) NULL,
        ADD COLUMN "provider_responded_at" timestamptz NULL,
        ADD COLUMN "refund_source" character varying(24) NULL,
        ADD COLUMN "refund_state" character varying(24) NULL,
        ADD COLUMN "refund_amount" numeric(78,0) NULL,
        ADD CONSTRAINT "chk_disputes_call_is_whole" CHECK (
          ("intent_id" IS NULL AND "respondent_provider_id" IS NULL AND "evidence_snapshot" IS NULL)
          OR ("intent_id" IS NOT NULL AND "respondent_provider_id" IS NOT NULL
              AND "evidence_snapshot" IS NOT NULL)
        ),
        ADD CONSTRAINT "chk_disputes_provider_response_is_whole" CHECK (
          ("provider_response" IS NULL) = ("provider_responded_at" IS NULL)
        ),
        ADD CONSTRAINT "chk_disputes_refund_source" CHECK (
          "refund_source" IS NULL OR "refund_source" IN ('UNCOLLECTED_EARNINGS', 'PROVIDER_STAKE', 'NONE')
        ),
        ADD CONSTRAINT "chk_disputes_refund_state" CHECK (
          "refund_state" IS NULL OR "refund_state" IN ('PENDING', 'REFUNDED', 'NOT_CHARGED', 'STAKE_CLAIM_OPEN')
        ),
        ADD CONSTRAINT "chk_disputes_refund_is_whole" CHECK (
          ("refund_source" IS NULL) = ("refund_state" IS NULL)
        ),
        ADD CONSTRAINT "chk_disputes_refund_amount_has_asset" CHECK (
          "refund_amount" IS NULL OR ("asset_id" IS NOT NULL AND "decimals" IS NOT NULL)
        )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_disputes_open_call" ON "disputes" ("intent_id") ` +
        `WHERE "intent_id" IS NOT NULL AND "state" IN ('OPEN', 'UNDER_REVIEW')`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_disputes_call_queue" ON "disputes" ("state", "created_at", "id") ` +
        `WHERE "intent_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_disputes_call_respondent" ON "disputes" ` +
        `("respondent_provider_id", "created_at", "id") WHERE "intent_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_disputes_call_buyer" ON "disputes" ` +
        `("organization_id", "created_at") WHERE "intent_id" IS NOT NULL`,
    );

    for (const table of ['payment_intents', 'verification_records']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN "dispute_outcome" character varying(16) NULL,
          ADD CONSTRAINT "chk_${table}_dispute_outcome" CHECK (
            "dispute_outcome" IS NULL OR "dispute_outcome" IN ('UPHELD', 'REJECTED')
          )
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['verification_records', 'payment_intents']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP CONSTRAINT "chk_${table}_dispute_outcome",
          DROP COLUMN "dispute_outcome"
      `);
    }
    await queryRunner.query(`DROP INDEX "idx_disputes_call_buyer"`);
    await queryRunner.query(`DROP INDEX "idx_disputes_call_respondent"`);
    await queryRunner.query(`DROP INDEX "idx_disputes_call_queue"`);
    await queryRunner.query(`DROP INDEX "uq_disputes_open_call"`);
    await queryRunner.query(`
      ALTER TABLE "disputes"
        DROP CONSTRAINT "chk_disputes_refund_amount_has_asset",
        DROP CONSTRAINT "chk_disputes_refund_is_whole",
        DROP CONSTRAINT "chk_disputes_refund_state",
        DROP CONSTRAINT "chk_disputes_refund_source",
        DROP CONSTRAINT "chk_disputes_provider_response_is_whole",
        DROP CONSTRAINT "chk_disputes_call_is_whole",
        DROP COLUMN "refund_amount",
        DROP COLUMN "refund_state",
        DROP COLUMN "refund_source",
        DROP COLUMN "provider_responded_at",
        DROP COLUMN "provider_response",
        DROP COLUMN "evidence_snapshot",
        DROP COLUMN "respondent_provider_id",
        DROP COLUMN "tool_id",
        DROP COLUMN "binding_id",
        DROP COLUMN "verdict_id",
        DROP COLUMN "intent_id"
    `);
  }
}
