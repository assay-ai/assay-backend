import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `payment_intents.credential_id` — the agent CREDENTIAL that made the call.
 *
 * An agent can hold several credentials, and since agent payment delegation
 * each credential is bound to a delegate key of its own: two credentials of
 * one agent are, for the person paying, two agents (two machines, two keys,
 * two grants). `GET /receipts/summary?groupBy=credential` splits spend by it,
 * which `agent_id` alone cannot (U02).
 *
 * Nullable, never back-filled: rows written before this column have no
 * credential to name, and the summary falls back to their agent.
 */
export class PaymentIntentCredential1759600000004 implements MigrationInterface {
  name = 'PaymentIntentCredential1759600000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payment_intents" ADD COLUMN "credential_id" uuid NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payment_intents" DROP COLUMN IF EXISTS "credential_id"`);
  }
}
