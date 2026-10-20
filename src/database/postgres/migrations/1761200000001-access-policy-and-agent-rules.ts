import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Access policy and agent rules on the spend policy, per-key narrowing on
 * credentials, and `allowed_tools` dropped (design spec §7.2, §7.7, §11.2).
 *
 * ## `spend_policies`
 *
 * Same versioning as every other limit: the org row is the default, an agent
 * row overrides it, and a change writes a new version (`policy_version`).
 *
 * - `access_mode` `ALL` | `RESTRICTED`, with `allowed_toolsets`
 *   (`[{ toolsetId, version, viaUrlOnly }]`) and `allowed_tool_ids`.
 * - The agent rules: `rule_exclude_provider_ids`, `rule_max_price` (atomic
 *   units of the policy's own `asset_id`), `rule_min_tier` (`ProviderTier`)
 *   and `rule_min_quality` (0..1, stored, inert until backlog G1.1).
 * - `pinned_tools`, the agent's "Always loaded" tools (at most 5).
 *
 * `allowed_tools` is dropped in the same migration, with no conversion:
 * nothing runs in production, and the access policy replaces it outright.
 *
 * ## `agent_credentials`
 *
 * A key can only narrow its agent's access: the three columns are `NULL`
 * (narrow nothing) or a second grant that is intersected with the agent's.
 */
export class AccessPolicyAndAgentRules1761200000001 implements MigrationInterface {
  name = 'AccessPolicyAndAgentRules1761200000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "spend_policies" DROP CONSTRAINT IF EXISTS "chk_spend_policies_allowed_tools_array"`,
    );
    await queryRunner.query(`ALTER TABLE "spend_policies" DROP COLUMN "allowed_tools"`);

    await queryRunner.query(`
      ALTER TABLE "spend_policies"
        ADD COLUMN "access_mode"               varchar(16)    NOT NULL DEFAULT 'ALL',
        ADD COLUMN "allowed_toolsets"          jsonb          NOT NULL DEFAULT '[]',
        ADD COLUMN "allowed_tool_ids"          uuid[]         NOT NULL DEFAULT '{}',
        ADD COLUMN "rule_exclude_provider_ids" uuid[]         NOT NULL DEFAULT '{}',
        ADD COLUMN "rule_max_price"            numeric(78,0)  NULL,
        ADD COLUMN "rule_min_tier"             varchar(16)    NULL,
        ADD COLUMN "rule_min_quality"          numeric(4,3)   NULL,
        ADD COLUMN "pinned_tools"              text[]         NOT NULL DEFAULT '{}'
    `);
    await queryRunner.query(`
      ALTER TABLE "spend_policies"
        ADD CONSTRAINT "chk_spend_policies_access_mode"
          CHECK ("access_mode" IN ('ALL', 'RESTRICTED')),
        ADD CONSTRAINT "chk_spend_policies_allowed_toolsets_array"
          CHECK (jsonb_typeof("allowed_toolsets") = 'array'),
        ADD CONSTRAINT "chk_spend_policies_rule_max_price_non_negative"
          CHECK ("rule_max_price" IS NULL OR "rule_max_price" >= 0),
        ADD CONSTRAINT "chk_spend_policies_rule_min_tier"
          CHECK ("rule_min_tier" IS NULL OR "rule_min_tier" IN ('NEW', 'ESTABLISHED', 'TRUSTED')),
        ADD CONSTRAINT "chk_spend_policies_rule_min_quality"
          CHECK ("rule_min_quality" IS NULL OR ("rule_min_quality" >= 0 AND "rule_min_quality" <= 1)),
        ADD CONSTRAINT "chk_spend_policies_pinned_tools"
          CHECK (cardinality("pinned_tools") <= 5)
    `);

    await queryRunner.query(`
      ALTER TABLE "agent_credentials"
        ADD COLUMN "access_mode"      varchar(16)  NULL,
        ADD COLUMN "allowed_toolsets" jsonb        NULL,
        ADD COLUMN "allowed_tool_ids" uuid[]       NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_credentials"
        ADD CONSTRAINT "chk_agent_credentials_access_mode"
          CHECK ("access_mode" IS NULL OR "access_mode" IN ('ALL', 'RESTRICTED')),
        ADD CONSTRAINT "chk_agent_credentials_allowed_toolsets_array"
          CHECK ("allowed_toolsets" IS NULL OR jsonb_typeof("allowed_toolsets") = 'array')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "agent_credentials"
        DROP CONSTRAINT "chk_agent_credentials_allowed_toolsets_array",
        DROP CONSTRAINT "chk_agent_credentials_access_mode",
        DROP COLUMN "allowed_tool_ids",
        DROP COLUMN "allowed_toolsets",
        DROP COLUMN "access_mode"
    `);
    await queryRunner.query(`
      ALTER TABLE "spend_policies"
        DROP CONSTRAINT "chk_spend_policies_pinned_tools",
        DROP CONSTRAINT "chk_spend_policies_rule_min_quality",
        DROP CONSTRAINT "chk_spend_policies_rule_min_tier",
        DROP CONSTRAINT "chk_spend_policies_rule_max_price_non_negative",
        DROP CONSTRAINT "chk_spend_policies_allowed_toolsets_array",
        DROP CONSTRAINT "chk_spend_policies_access_mode",
        DROP COLUMN "pinned_tools",
        DROP COLUMN "rule_min_quality",
        DROP COLUMN "rule_min_tier",
        DROP COLUMN "rule_max_price",
        DROP COLUMN "rule_exclude_provider_ids",
        DROP COLUMN "allowed_tool_ids",
        DROP COLUMN "allowed_toolsets",
        DROP COLUMN "access_mode"
    `);
    await queryRunner.query(`ALTER TABLE "spend_policies" ADD COLUMN "allowed_tools" jsonb`);
    await queryRunner.query(`
      ALTER TABLE "spend_policies"
        ADD CONSTRAINT "chk_spend_policies_allowed_tools_array"
          CHECK ("allowed_tools" IS NULL OR jsonb_typeof("allowed_tools") = 'array')
    `);
  }
}
