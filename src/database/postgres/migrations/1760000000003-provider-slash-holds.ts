import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `provider_slash_holds`: the per-chain "slash hold" that stops routing paid
 * calls to a provider whose penalties cannot be collected promptly (a full
 * slash window with an upheld record waiting, a stake fully reserved by
 * pending slashes, or bonded below the minimum). Written by the scheduler's
 * `EvmSlashHoldMonitor`, read on every routing decision and payment intent.
 */
export class ProviderSlashHolds1760000000003 implements MigrationInterface {
  name = 'ProviderSlashHolds1760000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "provider_slash_holds" (
        "id"           uuid         NOT NULL DEFAULT gen_random_uuid(),
        "provider_id"  uuid         NOT NULL,
        "chain_id"     varchar(64)  NOT NULL,
        "held"         boolean      NOT NULL DEFAULT false,
        "reasons"      jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "clear_checks" integer      NOT NULL DEFAULT 0,
        "held_since"   timestamptz,
        "released_at"  timestamptz,
        "checked_at"   timestamptz,
        "created_at"   timestamptz  NOT NULL DEFAULT now(),
        "updated_at"   timestamptz  NOT NULL DEFAULT now(),
        "version"      integer      NOT NULL DEFAULT 1,
        CONSTRAINT "pk_provider_slash_holds" PRIMARY KEY ("id"),
        CONSTRAINT "chk_provider_slash_holds_clear_checks" CHECK ("clear_checks" >= 0),
        CONSTRAINT "chk_provider_slash_holds_held_since" CHECK (NOT "held" OR "held_since" IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_provider_slash_holds_provider_chain"
         ON "provider_slash_holds" ("provider_id", "chain_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_provider_slash_holds_held" ON "provider_slash_holds" ("provider_id")
         WHERE "held"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "provider_slash_holds"`);
  }
}
