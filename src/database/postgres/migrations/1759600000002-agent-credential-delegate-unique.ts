import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `uq_agent_credentials_delegate_live` — a delegate key is bound to at most ONE
 * live (not revoked, not deleted) agent credential, platform-wide.
 *
 * Without it a second credential — another agent, or another tenant's — that
 * also holds the key could bind it too (D1-S03): the key's spending would no
 * longer be attributable to one agent, and revoking the credential the payer
 * authorised it for would not end it. `AgentDelegateService.bind` checks first
 * and answers `ACCOUNT_DELEGATE_ALREADY_BOUND`; this index decides a race.
 *
 * Case-insensitive, as the comparison in the service is. An expired credential
 * is still inside the index (a predicate cannot read the clock); the service
 * releases an expired holder's binding before it binds.
 *
 * Duplicates that exist before the index (only possible while this rule was
 * missing) are ALL unbound: no column says which holder is the legitimate one
 * (`delegate_bound_at` is moved by every re-bind, so "earliest wins" would
 * keep whichever agent did not re-bind last), and an unbound agent simply
 * binds again with a fresh proof. The payer's on-chain grant is untouched.
 */
export class AgentCredentialDelegateUnique1759600000002 implements MigrationInterface {
  name = 'AgentCredentialDelegateUnique1759600000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "agent_credentials" SET "delegate_account" = NULL, "delegate_bound_at" = NULL ` +
        `WHERE "revoked_at" IS NULL AND "deleted_at" IS NULL AND lower("delegate_account") IN (` +
        `SELECT lower("delegate_account") FROM "agent_credentials" ` +
        `WHERE "delegate_account" IS NOT NULL AND "revoked_at" IS NULL AND "deleted_at" IS NULL ` +
        `GROUP BY lower("delegate_account") HAVING count(*) > 1)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_agent_credentials_delegate_live" ON "agent_credentials" ` +
        `(lower("delegate_account")) ` +
        `WHERE "delegate_account" IS NOT NULL AND "revoked_at" IS NULL AND "deleted_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_agent_credentials_delegate_live"`);
  }
}
