import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Narrows `idx_payment_intents_idempotency_key` to the intents that may still
 * charge the agent (G2.1).
 *
 * The index was unique over every row that carried a key, whatever its status.
 * Nothing wrote a key until the MCP `tools/call` path started passing
 * `_meta["x402/idempotency-key"]`, and that caller needs one thing the old
 * index forbids: a call that **failed without a charge** must leave its key
 * free, so the agent's retry runs as a fresh attempt instead of being answered
 * with a dead intent forever.
 *
 * The three statuses left out are exactly the ones in which the agent was not
 * charged:
 *
 * - `VOIDED` — the provider failed or nothing was routable; the hold was
 *   released.
 * - `EXPIRED` — the intent never got moving (no funds secured, or the sweep
 *   released them).
 * - `REFUNDED` — the hold was released after verification failed.
 *
 * Every other status — `CREATED` through `SETTLED` — keeps the key, so two
 * attempts of one logical call can never both hold the agent's money. A row
 * that moves into one of the three releases its key by leaving the index;
 * Postgres maintains a partial index on UPDATE, so no trigger is needed.
 *
 * Existing rows are unaffected in practice: no caller wrote `idempotency_key`
 * before this change. The index stays unique on the same columns, so
 * `PaymentIntentService.create`'s insert-first arbitration works unchanged.
 */
export class IdempotencyKeyLiveIntents1761000000000 implements MigrationInterface {
  name = 'IdempotencyKeyLiveIntents1761000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_idempotency_key"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_payment_intents_idempotency_key"
        ON "payment_intents" ("organization_id", "agent_id", "idempotency_key")
        WHERE "idempotency_key" IS NOT NULL
          AND "status" NOT IN ('VOIDED', 'EXPIRED', 'REFUNDED')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Fails if two rows now share a key (one dead, one live). That is the
    // honest outcome: the wider index cannot be restored over data it forbids.
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_idempotency_key"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_payment_intents_idempotency_key"
        ON "payment_intents" ("organization_id", "agent_id", "idempotency_key")
        WHERE "idempotency_key" IS NOT NULL
    `);
  }
}
