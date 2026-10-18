import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Provider tools (design spec §7.1, §7.6, phase T4).
 *
 * - `tools`: the review state of a PROVIDER tool beside the T1 columns —
 *   `review_version` (the version under review, or the one last decided),
 *   `approved_version` (the newest version an operator approved: what LISTED
 *   surfaces serve), when it was submitted and decided and by whom, and the
 *   content hash the submission was for, so an approval can never be for
 *   content that changed after the operator read it. A takedown (FR-18) sets
 *   `removed_at` and keeps the status it replaced, so a reverted cutoff can
 *   restore it. `review_version` has no foreign key on purpose: it may name
 *   a draft, and a rejected draft may be discarded.
 * - Name rules, as CHECKs: a PROVIDER name is `{handle}__{tool}` with the
 *   §7.1 caps (`{tool}` at most 40 characters, no `__` inside it, the whole
 *   name at most 48). STANDARD tools carry no review state; a PROVIDER tool
 *   always does, and is LISTED only with an approved version.
 * - `tool_versions.declared_rules`: the verification rules a provider
 *   declares for its own contract, in the existing rule dialect.
 * - `moderation_cutoffs` accepts `TOOL`: a provider tool's takedown is
 *   confirmed by a second operator within 72 hours like any other cutoff.
 * - `tool_promotion_invites`: an operator drafted a standard contract from a
 *   provider tool (§7.5 "Promotion") and invited that tool's provider to bind.
 */
export const PROVIDER_TOOL_NAME_SQL = `'^[a-z][a-z0-9-]{2,23}__[a-z][a-z0-9_]{1,39}$'`;

export class ProviderTools1761900000000 implements MigrationInterface {
  name = 'ProviderTools1761900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tools"
        ADD COLUMN "review_version"        integer      NULL,
        ADD COLUMN "approved_version"      integer      NULL,
        ADD COLUMN "review_submitted_at"   timestamptz  NULL,
        ADD COLUMN "reviewed_at"           timestamptz  NULL,
        ADD COLUMN "reviewed_by"           uuid         NULL,
        ADD COLUMN "review_content_hash"   varchar(64)  NULL,
        ADD COLUMN "removed_at"            timestamptz  NULL,
        ADD COLUMN "removal_reason"        varchar(16)  NULL,
        ADD COLUMN "status_before_removal" varchar(16)  NULL,
        ADD CONSTRAINT "fk_tools_approved_version"
          FOREIGN KEY ("id", "approved_version") REFERENCES "tool_versions" ("tool_id", "version"),
        ADD CONSTRAINT "chk_tools_provider_name"
          CHECK ("kind" <> 'PROVIDER'
                 OR ("name" ~ ${PROVIDER_TOOL_NAME_SQL}
                     AND position('__' IN substr("name", position('__' IN "name") + 2)) = 0
                     AND length("name") <= 48)),
        ADD CONSTRAINT "chk_tools_review_kind"
          CHECK (("kind" = 'PROVIDER') = ("review_status" IS NOT NULL)),
        ADD CONSTRAINT "chk_tools_review_pending"
          CHECK ("review_status" IS DISTINCT FROM 'PENDING'
                 OR ("review_version" IS NOT NULL AND "review_submitted_at" IS NOT NULL
                     AND "review_content_hash" IS NOT NULL)),
        ADD CONSTRAINT "chk_tools_listed_approved"
          CHECK ("kind" <> 'PROVIDER' OR "visibility" <> 'LISTED' OR "approved_version" IS NOT NULL),
        ADD CONSTRAINT "chk_tools_removal"
          CHECK (("removed_at" IS NULL) = ("removal_reason" IS NULL)
                 AND ("removal_reason" IS NULL OR "removal_reason" IN ('TAKEDOWN', 'PROVIDER'))
                 AND ("removed_at" IS NULL OR "status" = 'REMOVED'))
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_tools_provider_owner"
        ON "tools" ("owner_org_id") WHERE "kind" = 'PROVIDER'
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_tools_review_pending"
        ON "tools" ("review_submitted_at") WHERE "review_status" = 'PENDING'
    `);

    await queryRunner.query(`
      ALTER TABLE "tool_versions"
        ADD COLUMN "declared_rules" jsonb NOT NULL DEFAULT '[]',
        ADD CONSTRAINT "chk_tool_versions_declared_rules"
          CHECK (jsonb_typeof("declared_rules") = 'array')
    `);

    await queryRunner.query(
      `ALTER TABLE "moderation_cutoffs" DROP CONSTRAINT "chk_moderation_cutoffs_target"`,
    );
    await queryRunner.query(`
      ALTER TABLE "moderation_cutoffs"
        ADD CONSTRAINT "chk_moderation_cutoffs_target"
          CHECK ("target_type" IN ('TOOLSET', 'HANDLE', 'TOOL'))
    `);

    await queryRunner.query(`
      CREATE TABLE "tool_promotion_invites" (
        "standard_tool_id" uuid         NOT NULL,
        "source_tool_id"   uuid         NOT NULL,
        "organization_id"  uuid         NOT NULL,
        "invited_by"       uuid         NOT NULL,
        "invited_at"       timestamptz  NOT NULL DEFAULT now(),
        "dismissed_at"     timestamptz  NULL,
        CONSTRAINT "pk_tool_promotion_invites" PRIMARY KEY ("standard_tool_id", "source_tool_id"),
        CONSTRAINT "fk_tool_promotion_invites_standard"
          FOREIGN KEY ("standard_tool_id") REFERENCES "tools" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_tool_promotion_invites_source"
          FOREIGN KEY ("source_tool_id") REFERENCES "tools" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_tool_promotion_invites_distinct"
          CHECK ("standard_tool_id" <> "source_tool_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_tool_promotion_invites_org"
        ON "tool_promotion_invites" ("organization_id", "invited_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "tool_promotion_invites"`);
    // A TOOL cutoff has no place in the old target set.
    await queryRunner.query(`DELETE FROM "moderation_cutoffs" WHERE "target_type" = 'TOOL'`);
    await queryRunner.query(
      `ALTER TABLE "moderation_cutoffs" DROP CONSTRAINT "chk_moderation_cutoffs_target"`,
    );
    await queryRunner.query(`
      ALTER TABLE "moderation_cutoffs"
        ADD CONSTRAINT "chk_moderation_cutoffs_target" CHECK ("target_type" IN ('TOOLSET', 'HANDLE'))
    `);
    await queryRunner.query(`
      ALTER TABLE "tool_versions"
        DROP CONSTRAINT "chk_tool_versions_declared_rules",
        DROP COLUMN "declared_rules"
    `);
    await queryRunner.query(`DROP INDEX "idx_tools_review_pending"`);
    await queryRunner.query(`DROP INDEX "idx_tools_provider_owner"`);
    await queryRunner.query(`
      ALTER TABLE "tools"
        DROP CONSTRAINT "chk_tools_removal",
        DROP CONSTRAINT "chk_tools_listed_approved",
        DROP CONSTRAINT "chk_tools_review_pending",
        DROP CONSTRAINT "chk_tools_review_kind",
        DROP CONSTRAINT "chk_tools_provider_name",
        DROP CONSTRAINT "fk_tools_approved_version",
        DROP COLUMN "status_before_removal",
        DROP COLUMN "removal_reason",
        DROP COLUMN "removed_at",
        DROP COLUMN "review_content_hash",
        DROP COLUMN "reviewed_by",
        DROP COLUMN "reviewed_at",
        DROP COLUMN "review_submitted_at",
        DROP COLUMN "approved_version",
        DROP COLUMN "review_version"
    `);
  }
}
