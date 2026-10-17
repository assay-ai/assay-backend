import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The observation pipeline behind `ProviderStats` (backlog G1.1).
 *
 * - `binding_attempts`: one row per routing attempt the provider is
 *   accountable for, written by the router. It is the only record of an
 *   attempt that failed over (the payment intent names only the binding that
 *   answered last) and the only per-attempt latency on the paid path. Pruned
 *   to a rolling window per binding by the stats refresh, so it stays small.
 * - `binding_stats`: one row per binding, the refresh's snapshot of that
 *   window plus the binding's recent verdicts. `DbProviderRegistry` reads it
 *   on every routing decision, in the same batch as the provider rows.
 *
 * Both are platform data keyed by the provider's organization, like
 * `provider_slash_holds`.
 */
export class BindingObservations1761100000000 implements MigrationInterface {
  name = 'BindingObservations1761100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "binding_attempts" (
        "id"          uuid         NOT NULL DEFAULT gen_random_uuid(),
        "binding_id"  uuid         NOT NULL,
        "provider_id" uuid         NOT NULL,
        "call_class"  varchar(8),
        "available"   boolean      NOT NULL,
        "latency_ms"  integer,
        "reason"      varchar(48)  NOT NULL,
        "created_at"  timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_binding_attempts" PRIMARY KEY ("id"),
        CONSTRAINT "chk_binding_attempts_latency" CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_binding_attempts_binding_created"
         ON "binding_attempts" ("binding_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_binding_attempts_provider_created"
         ON "binding_attempts" ("provider_id", "created_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "binding_stats" (
        "id"                 uuid         NOT NULL DEFAULT gen_random_uuid(),
        "binding_id"         uuid         NOT NULL,
        "provider_id"        uuid         NOT NULL,
        "attempts"           integer      NOT NULL DEFAULT 0,
        "available_attempts" integer      NOT NULL DEFAULT 0,
        "latency_samples"    integer      NOT NULL DEFAULT 0,
        "p50_latency_ms"     integer,
        "p95_latency_ms"     integer,
        "verdicts"           integer      NOT NULL DEFAULT 0,
        "passed_verdicts"    integer      NOT NULL DEFAULT 0,
        "refreshed_at"       timestamptz  NOT NULL,
        "created_at"         timestamptz  NOT NULL DEFAULT now(),
        "updated_at"         timestamptz  NOT NULL DEFAULT now(),
        "version"            integer      NOT NULL DEFAULT 1,
        CONSTRAINT "pk_binding_stats" PRIMARY KEY ("id"),
        CONSTRAINT "chk_binding_stats_attempts"
          CHECK ("available_attempts" >= 0 AND "available_attempts" <= "attempts"),
        CONSTRAINT "chk_binding_stats_latency_samples"
          CHECK ("latency_samples" >= 0 AND "latency_samples" <= "attempts"),
        CONSTRAINT "chk_binding_stats_verdicts"
          CHECK ("passed_verdicts" >= 0 AND "passed_verdicts" <= "verdicts")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_binding_stats_binding" ON "binding_stats" ("binding_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_binding_stats_provider" ON "binding_stats" ("provider_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "binding_stats"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "binding_attempts"`);
  }
}
