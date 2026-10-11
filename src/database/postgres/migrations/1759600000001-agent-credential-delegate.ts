import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `agent_credentials.delegate_account` / `delegate_bound_at` — which DELEGATE
 * key an agent credential signs vouchers with.
 *
 * The agent proves possession of the key (a signature by it over a single-use
 * challenge) before the binding is written, so an MCP session knows which key
 * its vouchers come from and PAYMENT_REQUIRED can name it. The binding grants
 * nothing on chain: the payer's on-chain authorisation of the delegate is what
 * lets it spend. CAIP-10, 256 wide like every account column.
 */
export class AgentCredentialDelegate1759600000001 implements MigrationInterface {
  name = 'AgentCredentialDelegate1759600000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" ADD COLUMN "delegate_account" varchar(256) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" ADD COLUMN "delegate_bound_at" timestamptz NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" ADD CONSTRAINT "chk_agent_credentials_delegate_pair" ` +
        `CHECK (("delegate_account" IS NULL) = ("delegate_bound_at" IS NULL))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" DROP CONSTRAINT IF EXISTS "chk_agent_credentials_delegate_pair"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" DROP COLUMN IF EXISTS "delegate_bound_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" DROP COLUMN IF EXISTS "delegate_account"`,
    );
  }
}
