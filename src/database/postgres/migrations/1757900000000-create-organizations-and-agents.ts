import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The tenant and the identity that creates it.
 *
 * ## What was actually missing
 *
 * Every business table has carried `organization_id uuid` since the first one,
 * and `OrganizationScopedRepository` has refused any query that does not name
 * it. What none of that had was a **row on the other end**. The ids came from
 * `MCP_CREDENTIALS_FILE`, a JSON file of demo bearer tokens, so "which
 * organizations exist" was a question the database could not answer and
 * "organization_id" referenced nothing at all. There was no person table
 * either: `agent_credentials.agent_id` is a bare uuid, and `AgentsService`
 * lists agents by grouping the credential file.
 *
 * A real login now sits in front of all of it, and the organization is created
 * automatically on sign-up, attached to the existing multi-organization
 * foundation rather than patched in by adding columns here and there. So this
 * is two tables, not a column added here and there.
 *
 * ## Why `agents` and not `users`
 *
 * The data model has specified this exact table since before there was an
 * issuer: `privy_user_id` unique, `primary_account_id` CAIP-10, a status. A
 * Privy identity and an agent are one row in that model, and every consumer on
 * the platform already reads `McpSession.agentId` — nothing anywhere reads a
 * "user". Adding `users` *beside* this would create a second identity that no
 * column references, which is exactly the scattering to avoid. Several agents
 * per human is a later requirement, and the seam for it is right here: drop the
 * unique index on `privy_user_id`, add `user_id`, and every consumer keeps
 * reading `agentId` unchanged.
 *
 * ## No foreign key from the other thirty tables
 *
 * `payment_intents.organization_id`, `verification_records.organization_id`
 * and every sibling stay unconstrained. Their rows carry ids invented by the
 * credential file and by `yarn demo:seed`; a constraint over that data either
 * refuses to apply or forces us to backfill fabricated parent rows, which
 * would make `organizations` lie about who exists on the day it was created.
 * The constraint is a later migration, and its precondition is that the last
 * invented id is gone.
 *
 * ## No soft delete
 *
 * Both tables are identities other rows are attributed to. A soft-deleted
 * tenant whose payments remain is a reconciliation hole with a nicer name, and
 * a soft-deleted agent still occupies its `privy_user_id` unique index, so the
 * same human could never log in again. Closing an account is `status`.
 *
 * ## `primary_account_id` is nullable
 *
 * It is the CAIP-10 account a call spends from and a withdrawal is authorised
 * against. The only honest source is a wallet the human controls; a freshly
 * authenticated identity with no linked Solana wallet has none, and inventing
 * one would put an address into `payment_intents.agent_account` that no key
 * can sign for. Null means "not yet" and the session source refuses to build a
 * spending session on it.
 */
export class CreateOrganizationsAndAgents1757900000000 implements MigrationInterface {
  name = 'CreateOrganizationsAndAgents1757900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "organizations" (
        "id"          uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"  timestamptz   NOT NULL DEFAULT now(),
        "updated_at"  timestamptz   NOT NULL DEFAULT now(),
        "version"     integer       NOT NULL DEFAULT 1,
        "name"        varchar(160)  NOT NULL,
        "status"      varchar(16)   NOT NULL DEFAULT 'ACTIVE',
        "created_via" varchar(32)   NOT NULL DEFAULT 'PRIVY_SIGNUP',
        CONSTRAINT "pk_organizations" PRIMARY KEY ("id"),
        CONSTRAINT "chk_organizations_status" CHECK ("status" IN ('ACTIVE', 'SUSPENDED'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "agents" (
        "id"                 uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"         timestamptz   NOT NULL DEFAULT now(),
        "updated_at"         timestamptz   NOT NULL DEFAULT now(),
        "version"            integer       NOT NULL DEFAULT 1,
        "organization_id"    uuid          NOT NULL,
        "privy_user_id"      varchar(128)  NOT NULL,
        "email"              varchar(320),
        "label"              varchar(128),
        "status"             varchar(16)   NOT NULL DEFAULT 'ACTIVE',
        "primary_account_id" varchar(160),
        "chain_id"           varchar(64),
        "last_login_at"      timestamptz,
        CONSTRAINT "pk_agents" PRIMARY KEY ("id"),
        CONSTRAINT "fk_agents_organization"
          FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT,
        CONSTRAINT "chk_agents_status" CHECK ("status" IN ('ACTIVE', 'SUSPENDED')),
        -- An account without the chain it lives on cannot be turned back into
        -- a CAIP-10 identity, and a chain without an account is a setting
        -- nothing reads. They are written together or not at all.
        CONSTRAINT "chk_agents_account_is_chained" CHECK (
          ("primary_account_id" IS NULL AND "chain_id" IS NULL)
          OR ("primary_account_id" IS NOT NULL AND "chain_id" IS NOT NULL)
        )
      )
    `);

    // The join a login performs, and the constraint that makes two concurrent
    // first logins for one DID resolve to one agent instead of two tenants.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_agents_privy_user_id" ON "agents" ("privy_user_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_agents_organization" ON "agents" ("organization_id")
    `);

    // One agent may hold at most one wallet, and no two agents may claim the
    // same one. Partial, because "not linked yet" is the common state and NULLs
    // must not collide with each other.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_agents_primary_account" ON "agents" ("primary_account_id")
      WHERE "primary_account_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_agents_primary_account"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_agents_organization"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_agents_privy_user_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agents"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "organizations"`);
  }
}
