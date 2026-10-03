import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The binding editor's three tables.
 *
 * `Tool` and `ToolBinding` first shipped as *types* with no table behind them,
 * and every consumer since has been reading `InMemoryToolCatalogue`: the
 * router, the MCP server, the provider console's binding list. This migration
 * is the one that lets a provider own their own binding.
 *
 * ```text
 * tool_bindings      the binding as it is now — editable while DRAFT
 *   └── binding_versions   one immutable row per saved revision
 *   └── binding_test_runs  what the mapping tester saw, per revision
 * ```
 *
 * ## Why `mapping_version` is not `version`
 *
 * `version` is already taken, platform-wide, by TypeORM's optimistic lock
 * (`AbstractEntity.@VersionColumn`). `ToolBinding.version` in the domain type
 * means something entirely different — *which stored revision of the mappings
 * served this call*, the thing a dispute months later has to agree on. Two
 * different numbers under one name in one row is a bug waiting for the first
 * person who writes `binding.version` meaning the other one, so the column says
 * which it is and the entity maps it back to the domain name at exactly one
 * place.
 *
 * ## The constraints doing real work
 *
 * **`uq_tool_bindings_organization_tool`** — a provider implements a tool
 * once. Not a tidiness rule: `ProviderRouterService` fails over by *excluding
 * the whole provider*, so two bindings from one provider for one tool would
 * put the same endpoint in the candidate set twice and make the second attempt
 * dial the party that just failed. The uniqueness is what makes failover mean
 * what its own doc comment says it means.
 *
 * **`chk_tool_bindings_active_is_published`** — a binding cannot be `ACTIVE`
 * without a `published_version` and a `published_at`. The publish gate is a
 * service, and a service can be bypassed by a repair script, a seeder or a
 * future caller; this is the row refusing to hold a state the gate never
 * produced. `PAUSED` is included because a paused binding is a *published*
 * binding whose traffic is off, not a draft.
 *
 * **`chk_tool_bindings_published_version_exists`** — `published_version` can
 * never exceed `mapping_version`. Editing a live binding raises
 * `mapping_version` and deliberately leaves `published_version` behind: that
 * gap is what "you have unpublished changes" is, and it is also what stops an
 * edit made after a green tester run from reaching traffic without a new run.
 *
 * **`uq_binding_test_runs_call_id`** — the tester mints a real `X-X402-Call-Id`
 * and sends it upstream. A provider who finds an unexplained call id in their
 * own logs must be able to resolve it to *something*; a sandbox run has no
 * `payment_intents` row (it must not — see `BindingMappingTesterService`), so
 * this table is the only place that id exists on our side, and it is unique for
 * the same reason `payment_intents`' is.
 *
 * ## What is deliberately absent
 *
 * No `tools` table. The tool contract — `inputSchema`, `outputSchema`, the
 * verification policy id — is authored by the platform, not by providers (a
 * launch catalogue of 24 tools), and catalogue seeding populates it. A `tools`
 * table written now would have exactly one writer, a seed file, which is what
 * `TOOL_CATALOGUE_SEED_FILE` already is. The catalogue port is what hides the
 * split: tools from the seed, bindings from here.
 *
 * No `approved_by` and no review state, for the reason `providers` has none:
 * registration is open and the gate is the publish check's two mechanical
 * checks — a green tester run against *this* revision, and stake at or above
 * the minimum. Neither is a human reading a submission.
 */
export class CreateToolBindingTables1756900000000 implements MigrationInterface {
  name = 'CreateToolBindingTables1756900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "tool_bindings" (
        "id"                   uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"           timestamptz   NOT NULL DEFAULT now(),
        "updated_at"           timestamptz   NOT NULL DEFAULT now(),
        "version"              integer       NOT NULL DEFAULT 1,
        "organization_id"      uuid          NOT NULL,
        "tool_id"              varchar(128)  NOT NULL,
        "endpoint"             varchar(2048) NOT NULL,
        "request_mapping"      jsonb         NOT NULL,
        "response_mapping"     jsonb         NOT NULL,
        "pricing_mode"         varchar(16)   NOT NULL,
        "price_amount"         numeric(78,0) NOT NULL,
        "asset_id"             varchar(256)  NOT NULL,
        "free_quota_per_agent" integer,
        "free_daily_budget"    numeric(78,0),
        "sla_failure_rate"     numeric(6,5)  NOT NULL,
        "timeout_ms"           integer       NOT NULL,
        "status"               varchar(16)   NOT NULL DEFAULT 'DRAFT',
        "mapping_version"      integer       NOT NULL DEFAULT 1,
        "published_version"    integer,
        "published_at"         timestamptz,
        CONSTRAINT "pk_tool_bindings" PRIMARY KEY ("id"),
        CONSTRAINT "uq_tool_bindings_organization_tool" UNIQUE ("organization_id", "tool_id"),
        CONSTRAINT "chk_tool_bindings_status"
          CHECK ("status" IN ('DRAFT', 'ACTIVE', 'PAUSED', 'SUSPENDED')),
        CONSTRAINT "chk_tool_bindings_pricing_mode"
          CHECK ("pricing_mode" IN ('FREE', 'FREEMIUM', 'PAID')),
        CONSTRAINT "chk_tool_bindings_price_non_negative"
          CHECK ("price_amount" >= 0),
        CONSTRAINT "chk_tool_bindings_free_is_free"
          CHECK ("pricing_mode" <> 'FREE' OR "price_amount" = 0),
        CONSTRAINT "chk_tool_bindings_timeout_range"
          CHECK ("timeout_ms" > 0 AND "timeout_ms" <= 120000),
        CONSTRAINT "chk_tool_bindings_sla_failure_rate_range"
          CHECK ("sla_failure_rate" >= 0 AND "sla_failure_rate" <= 1),
        CONSTRAINT "chk_tool_bindings_mapping_version_positive"
          CHECK ("mapping_version" >= 1),
        CONSTRAINT "chk_tool_bindings_active_is_published"
          CHECK (
            "status" NOT IN ('ACTIVE', 'PAUSED')
            OR ("published_version" IS NOT NULL AND "published_at" IS NOT NULL)
          ),
        CONSTRAINT "chk_tool_bindings_published_together"
          CHECK (("published_version" IS NULL) = ("published_at" IS NULL)),
        CONSTRAINT "chk_tool_bindings_published_version_exists"
          CHECK ("published_version" IS NULL OR "published_version" <= "mapping_version")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_tool_bindings_organization_id" ON "tool_bindings" ("organization_id")`,
    );
    // The router's read: every binding for one tool, across every provider.
    await queryRunner.query(
      `CREATE INDEX "idx_tool_bindings_tool_id_status" ON "tool_bindings" ("tool_id", "status")`,
    );

    await queryRunner.query(`
      CREATE TABLE "binding_versions" (
        "id"               uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"       timestamptz   NOT NULL DEFAULT now(),
        "updated_at"       timestamptz   NOT NULL DEFAULT now(),
        "version"          integer       NOT NULL DEFAULT 1,
        "organization_id"  uuid          NOT NULL,
        "binding_id"       uuid          NOT NULL,
        "mapping_version"  integer       NOT NULL,
        "tool_id"          varchar(128)  NOT NULL,
        "endpoint"         varchar(2048) NOT NULL,
        "request_mapping"  jsonb         NOT NULL,
        "response_mapping" jsonb         NOT NULL,
        "pricing_mode"     varchar(16)   NOT NULL,
        "price_amount"     numeric(78,0) NOT NULL,
        "asset_id"         varchar(256)  NOT NULL,
        "timeout_ms"       integer       NOT NULL,
        "authored_by"      varchar(128)  NOT NULL,
        "published_at"     timestamptz,
        "published_by"     varchar(128),
        CONSTRAINT "pk_binding_versions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_binding_versions_binding_mapping_version"
          UNIQUE ("binding_id", "mapping_version"),
        CONSTRAINT "fk_binding_versions_binding"
          FOREIGN KEY ("binding_id") REFERENCES "tool_bindings" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_binding_versions_published_attributed"
          CHECK (("published_at" IS NULL) = ("published_by" IS NULL))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_binding_versions_organization_id" ` +
        `ON "binding_versions" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_binding_versions_binding_id" ON "binding_versions" ("binding_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "binding_test_runs" (
        "id"              uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz  NOT NULL DEFAULT now(),
        "updated_at"      timestamptz  NOT NULL DEFAULT now(),
        "version"         integer      NOT NULL DEFAULT 1,
        "organization_id" uuid         NOT NULL,
        "binding_id"      uuid         NOT NULL,
        "mapping_version" integer      NOT NULL,
        "call_id"         uuid         NOT NULL,
        "outcome"         varchar(16)  NOT NULL,
        "failed_layer"    varchar(24),
        "sample_input"    jsonb        NOT NULL,
        "report"          jsonb        NOT NULL,
        "ran_by"          varchar(128) NOT NULL,
        CONSTRAINT "pk_binding_test_runs" PRIMARY KEY ("id"),
        CONSTRAINT "uq_binding_test_runs_call_id" UNIQUE ("call_id"),
        CONSTRAINT "fk_binding_test_runs_binding"
          FOREIGN KEY ("binding_id") REFERENCES "tool_bindings" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_binding_test_runs_outcome"
          CHECK ("outcome" IN ('PASSED', 'FAILED')),
        CONSTRAINT "chk_binding_test_runs_failure_is_located"
          CHECK (("outcome" = 'PASSED') = ("failed_layer" IS NULL))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_binding_test_runs_organization_id" ` +
        `ON "binding_test_runs" ("organization_id")`,
    );
    // The publish gate's read: the newest run for one binding at one revision.
    await queryRunner.query(
      `CREATE INDEX "idx_binding_test_runs_binding_revision" ` +
        `ON "binding_test_runs" ("binding_id", "mapping_version", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "binding_test_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "binding_versions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tool_bindings"`);
  }
}
