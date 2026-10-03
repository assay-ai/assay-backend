import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The provider registration record, the payout
 * proof nonce, and the endpoint probe log.
 *
 * ## The three constraints doing real work
 *
 * **`uq_providers_organization_id`** — one organization is one provider.
 * `ProviderProfileService` has keyed on that equivalence from the start with no
 * row to enforce it; as a unique index, a duplicate registration fails in
 * Postgres instead of racing a read-then-write and leaving two rows that
 * `GET /providers/me` would have to pick between.
 *
 * **`chk_providers_verified_attributed`** — `verified` cannot be true without
 * `verified_by` and `verified_at`. `verified` is a label a buyer is meant to
 * weigh, and a flag with no author is not weighable. The check is what makes
 * "verified" un-settable by an `UPDATE providers SET verified = true` typed
 * during an incident.
 *
 * **`chk_provider_payout_challenges_message_version`** and the `UNIQUE` on
 * `nonce` — a nonce is single-use platform-wide, not per organization. Scoping
 * uniqueness to the tenant would let one organization's spent nonce be
 * replayed by another, and the value of a nonce is precisely that it is spent
 * once anywhere.
 *
 * ## What is deliberately absent
 *
 * No `approval_state`, no `reviewed_by`, no `approved_at`. Registration is
 * open, and a column that models an approval is a column something will
 * eventually be written into. Its absence is the enforcement.
 *
 * There is also no column for an *unproved* payout address. `payout_account_id`
 * is written together with `payout_proof` by the payout-address verification
 * path or not at all, so there is no state in which the schema holds an address
 * nobody proved control of.
 */
export class CreateProviderRegistrationTables1756600000000 implements MigrationInterface {
  name = 'CreateProviderRegistrationTables1756600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "providers" (
        "id"                        uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"                timestamptz   NOT NULL DEFAULT now(),
        "updated_at"                timestamptz   NOT NULL DEFAULT now(),
        "version"                   integer       NOT NULL DEFAULT 1,
        "organization_id"           uuid          NOT NULL,
        "legal_name"                varchar(200)  NOT NULL,
        "technical_contact"         jsonb         NOT NULL,
        "owner_contact"             jsonb         NOT NULL,
        "timezone"                  varchar(64)   NOT NULL,
        "accepted_terms"            jsonb         NOT NULL,
        "status"                    varchar(16)   NOT NULL DEFAULT 'ACTIVE',
        "tier"                      varchar(16)   NOT NULL DEFAULT 'NEW',
        "payout_account_id"         varchar(256),
        "payout_proof"              jsonb,
        "payout_proved_at"          timestamptz,
        "endpoint"                  varchar(2048),
        "verified"                  boolean       NOT NULL DEFAULT false,
        "verified_by"               varchar(200),
        "verified_at"               timestamptz,
        "verification_method"       varchar(64),
        "verification_checks"       jsonb         NOT NULL DEFAULT '[]'::jsonb,
        "verification_expires_at"   timestamptz,
        "verification_evidence_url" varchar(2048),
        CONSTRAINT "pk_providers" PRIMARY KEY ("id"),
        CONSTRAINT "uq_providers_organization_id" UNIQUE ("organization_id"),
        CONSTRAINT "chk_providers_status"
          CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'UNBONDING')),
        CONSTRAINT "chk_providers_tier"
          CHECK ("tier" IN ('NEW', 'ESTABLISHED', 'TRUSTED')),
        CONSTRAINT "chk_providers_verified_attributed"
          CHECK ("verified" = false OR ("verified_by" IS NOT NULL AND "verified_at" IS NOT NULL)),
        CONSTRAINT "chk_providers_payout_proved_together"
          CHECK (("payout_account_id" IS NULL) = ("payout_proof" IS NULL))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_providers_organization_id" ON "providers" ("organization_id")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_providers_verified" ON "providers" ("verified")`);

    await queryRunner.query(`
      CREATE TABLE "provider_payout_challenges" (
        "id"              uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz  NOT NULL DEFAULT now(),
        "updated_at"      timestamptz  NOT NULL DEFAULT now(),
        "version"         integer      NOT NULL DEFAULT 1,
        "organization_id" uuid         NOT NULL,
        "nonce"           varchar(64)  NOT NULL,
        "account_id"      varchar(256) NOT NULL,
        "message"         text         NOT NULL,
        "message_version" varchar(64)  NOT NULL,
        "channel"         varchar(16)  NOT NULL DEFAULT 'CONSOLE',
        "expires_at"      timestamptz  NOT NULL,
        "consumed_at"     timestamptz,
        "issued_to"       varchar(128) NOT NULL,
        CONSTRAINT "pk_provider_payout_challenges" PRIMARY KEY ("id"),
        CONSTRAINT "uq_provider_payout_challenges_nonce" UNIQUE ("nonce"),
        CONSTRAINT "chk_provider_payout_challenges_nonce_hex"
          CHECK ("nonce" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "chk_provider_payout_challenges_channel"
          CHECK ("channel" = 'CONSOLE')
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_provider_payout_challenges_organization_id" ` +
        `ON "provider_payout_challenges" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_provider_payout_challenges_open" ` +
        `ON "provider_payout_challenges" ("organization_id", "consumed_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "provider_connectivity_checks" (
        "id"              uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz   NOT NULL DEFAULT now(),
        "updated_at"      timestamptz   NOT NULL DEFAULT now(),
        "version"         integer       NOT NULL DEFAULT 1,
        "organization_id" uuid          NOT NULL,
        "endpoint"        varchar(2048) NOT NULL,
        "outcome"         varchar(16)   NOT NULL,
        "status_code"     integer,
        "latency_ms"      integer,
        "failure_kind"    varchar(48),
        "failure_code"    varchar(64),
        "detail"          varchar(512),
        "egress_ips"      jsonb         NOT NULL DEFAULT '[]'::jsonb,
        CONSTRAINT "pk_provider_connectivity_checks" PRIMARY KEY ("id"),
        CONSTRAINT "chk_provider_connectivity_checks_outcome"
          CHECK ("outcome" IN ('REACHABLE', 'UNREACHABLE', 'BLOCKED'))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_provider_connectivity_checks_organization_id" ` +
        `ON "provider_connectivity_checks" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_provider_connectivity_checks_org_created" ` +
        `ON "provider_connectivity_checks" ("organization_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "provider_connectivity_checks"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "provider_payout_challenges"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "providers"`);
  }
}
