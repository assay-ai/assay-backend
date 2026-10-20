import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Handles: an organization's public namespace, `@acme` (design spec §7.1, §7.2).
 *
 * ## `organizations`
 *
 * `handle` (lowercase, the spec's format), `handle_locked_at` (set by the
 * first UNLISTED or PUBLIC share; after it a rename goes through an operator)
 * and `handle_status` (`ACTIVE` | `FROZEN` — a takedown freezes it, and every
 * URL under it stops). Unique ignoring case, and unique by `handle_skeleton`
 * — the name with look-alikes folded (`strlpe` reads as `stripe`) — so no
 * organization can take a name that reads as another's.
 *
 * ## `org_handle_history`
 *
 * Old handles: an operator rename keeps the old one as an alias until
 * `alias_until` (90 days), then holds it forever; a takedown that ends in a
 * reassignment records where it went. A row with `reassigned_at IS NULL` holds
 * its handle: nobody can claim it.
 *
 * One deviation from the spec's sketch: the key is a generated `id`, not
 * `old_handle`. A handle can leave an organization more than once (renamed
 * away, reassigned to another org, renamed away again), and each is a fact
 * worth keeping. "At most one holder" is the partial unique index instead.
 *
 * ## `org_handle_claims`
 *
 * One row per claim or change, naming the Privy user who made it, for the
 * claim gate: one user claims handles for at most 3 organizations in 30 days.
 */
export class OrgHandles1761400000000 implements MigrationInterface {
  name = 'OrgHandles1761400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "organizations"
        ADD COLUMN "handle"           varchar(24) NULL,
        ADD COLUMN "handle_locked_at" timestamptz NULL,
        ADD COLUMN "handle_status"    varchar(16) NULL,
        ADD COLUMN "handle_skeleton"  varchar(24) NULL,
        ADD CONSTRAINT "chk_organizations_handle"
          CHECK ("handle" IS NULL OR "handle" ~ '^[a-z][a-z0-9-]{2,23}$'),
        ADD CONSTRAINT "chk_organizations_handle_skeleton"
          CHECK (("handle" IS NULL) = ("handle_skeleton" IS NULL)),
        ADD CONSTRAINT "chk_organizations_handle_status"
          CHECK (("handle" IS NULL) = ("handle_status" IS NULL)
                 AND ("handle_status" IS NULL OR "handle_status" IN ('ACTIVE', 'FROZEN')))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_organizations_handle"
        ON "organizations" (lower("handle")) WHERE "handle" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_organizations_handle_skeleton"
        ON "organizations" ("handle_skeleton") WHERE "handle_skeleton" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "org_handle_history" (
        "id"                   uuid         NOT NULL DEFAULT gen_random_uuid(),
        "old_handle"           varchar(24)  NOT NULL,
        "old_skeleton"         varchar(24)  NOT NULL,
        "org_id"               uuid         NOT NULL,
        "reason"               varchar(16)  NOT NULL,
        "new_handle"           varchar(24)  NULL,
        "changed_at"           timestamptz  NOT NULL DEFAULT now(),
        "alias_until"          timestamptz  NULL,
        "reassigned_to_org_id" uuid         NULL,
        "reassigned_at"        timestamptz  NULL,
        CONSTRAINT "pk_org_handle_history" PRIMARY KEY ("id"),
        CONSTRAINT "chk_org_handle_history_reason"
          CHECK ("reason" IN ('RENAME', 'TAKEDOWN', 'ORG_DELETED')),
        CONSTRAINT "chk_org_handle_history_alias"
          CHECK ("reason" = 'RENAME' OR "alias_until" IS NULL),
        CONSTRAINT "chk_org_handle_history_reassigned"
          CHECK (("reassigned_to_org_id" IS NULL) = ("reassigned_at" IS NULL))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_org_handle_history_held"
        ON "org_handle_history" (lower("old_handle")) WHERE "reassigned_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_org_handle_history_held_skeleton"
        ON "org_handle_history" ("old_skeleton") WHERE "reassigned_at" IS NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_org_handle_history_org" ON "org_handle_history" ("org_id", "changed_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "org_handle_claims" (
        "id"            uuid          NOT NULL DEFAULT gen_random_uuid(),
        "org_id"        uuid          NOT NULL,
        "privy_user_id" varchar(128)  NOT NULL,
        "handle"        varchar(24)   NOT NULL,
        "claimed_at"    timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "pk_org_handle_claims" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_org_handle_claims_user" ON "org_handle_claims" ("privy_user_id", "claimed_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "org_handle_claims"`);
    await queryRunner.query(`DROP TABLE "org_handle_history"`);
    await queryRunner.query(`DROP INDEX "uq_organizations_handle_skeleton"`);
    await queryRunner.query(`DROP INDEX "uq_organizations_handle"`);
    await queryRunner.query(`
      ALTER TABLE "organizations"
        DROP CONSTRAINT "chk_organizations_handle_skeleton",
        DROP CONSTRAINT "chk_organizations_handle_status",
        DROP CONSTRAINT "chk_organizations_handle",
        DROP COLUMN "handle_skeleton",
        DROP COLUMN "handle_status",
        DROP COLUMN "handle_locked_at",
        DROP COLUMN "handle"
    `);
  }
}
