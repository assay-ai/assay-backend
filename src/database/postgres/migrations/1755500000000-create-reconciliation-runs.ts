import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The reconciliation history table.
 *
 * Hand-written like its predecessors: the `severity` CHECK and the partial
 * index on breaches cannot be expressed as entity decorators, and a generated
 * migration would omit both silently.
 */
export class CreateReconciliationRuns1755500000000 implements MigrationInterface {
  name = 'CreateReconciliationRuns1755500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE "reconciliation_runs" (
        "id"                    uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"            TIMESTAMP     NOT NULL DEFAULT now(),
        "updated_at"            TIMESTAMP     NOT NULL DEFAULT now(),
        "version"               integer       NOT NULL DEFAULT 1,
        "asset_id"              character varying(256) NOT NULL,
        "decimals"              integer       NOT NULL,
        "vault_account"         character varying(256) NULL,
        "vault_balance"         numeric(78,0) NULL,
        "agent_liabilities"     numeric(78,0) NULL,
        "open_holds"            numeric(78,0) NULL,
        "provider_payable"      numeric(78,0) NULL,
        "platform_fees"         numeric(78,0) NULL,
        "total_liabilities"     numeric(78,0) NULL,
        "snapshot_liabilities"  numeric(78,0) NULL,
        -- Signed on purpose; see the column comment on the entity.
        "difference"            numeric(78,0) NULL,
        "severity"              character varying(16)  NOT NULL,
        "findings"              jsonb         NOT NULL DEFAULT '[]'::jsonb,
        "alerted"               boolean       NOT NULL DEFAULT false,
        "started_at"            TIMESTAMP WITH TIME ZONE NOT NULL,
        "finished_at"           TIMESTAMP WITH TIME ZONE NOT NULL,
        "duration_ms"           integer       NOT NULL,
        CONSTRAINT "pk_reconciliation_runs" PRIMARY KEY ("id"),
        CONSTRAINT "chk_reconciliation_runs_severity" CHECK ("severity" IN (
          'OK', 'WARN', 'CRITICAL'
        )),
        -- A run that produced figures must have produced all of them. A row
        -- with a vault balance but no liability total describes a comparison
        -- that never happened, and would read as a clean check.
        CONSTRAINT "chk_reconciliation_runs_figures_complete" CHECK (
          ("vault_balance" IS NULL) = ("total_liabilities" IS NULL)
          AND ("vault_balance" IS NULL) = ("difference" IS NULL)
        ),
        -- The one arithmetic identity in the table, enforced by Postgres rather
        -- than trusted from the application: the stored difference must be the
        -- stored subtraction. A reconciler bug that reports a healthy
        -- difference against unhealthy figures is exactly the silent money bug
        -- this whole item exists to prevent.
        CONSTRAINT "chk_reconciliation_runs_difference" CHECK (
          "difference" IS NULL
          OR "difference" = "vault_balance" - "total_liabilities"
        ),
        -- A breach is never allowed to be recorded as a clean run.
        CONSTRAINT "chk_reconciliation_runs_breach_is_critical" CHECK (
          "difference" IS NULL OR "difference" >= 0 OR "severity" = 'CRITICAL'
        )
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_reconciliation_runs_asset_started_at" ON "reconciliation_runs" ` +
        `("asset_id", "started_at" DESC)`,
    );

    // Drives "was the last run clean?" — the freeze check on the withdrawal
    // path reads exactly one row through this index on every request.
    await queryRunner.query(
      `CREATE INDEX "idx_reconciliation_runs_severity" ON "reconciliation_runs" ` +
        `("severity", "started_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "reconciliation_runs"`);
  }
}
