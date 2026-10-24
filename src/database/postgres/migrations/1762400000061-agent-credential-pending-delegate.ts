import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `agent_credentials.pending_delegate_account` / `pending_delegate_requested_at`:
 * a payment key the agent proved while another is bound. It replaces the bound
 * one only on the payer's approval (`POST /escrow/delegates` for that key), so
 * a new binding never silently replaces a live one. One live credential per
 * pending key, platform-wide, like `uq_agent_credentials_delegate_live`.
 */
export class AgentCredentialPendingDelegate1762400000061 implements MigrationInterface {
  name = 'AgentCredentialPendingDelegate1762400000061';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" ADD COLUMN "pending_delegate_account" varchar(256) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" ADD COLUMN "pending_delegate_requested_at" timestamptz NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" ADD CONSTRAINT "ck_agent_credentials_pending_delegate" ` +
        `CHECK (("pending_delegate_account" IS NULL) = ("pending_delegate_requested_at" IS NULL))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_agent_credentials_pending_delegate_live" ON "agent_credentials" ` +
        `(lower("pending_delegate_account")) ` +
        `WHERE "pending_delegate_account" IS NOT NULL AND "revoked_at" IS NULL AND "deleted_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_agent_credentials_pending_delegate_live"`);
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" DROP CONSTRAINT IF EXISTS "ck_agent_credentials_pending_delegate"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" DROP COLUMN IF EXISTS "pending_delegate_requested_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" DROP COLUMN IF EXISTS "pending_delegate_account"`,
    );
  }
}
