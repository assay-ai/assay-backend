import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Where a verdict's evidence is sealed.
 *
 * ## Why the evidence is not a column on `verification_records`
 *
 * That row is the worker's state machine: `state`, `attempts`, `last_error`
 * and `settled_at` all move after a verdict exists. An evidence pack living on
 * a row that is still being written is not immutable in any sense a test can
 * check, and no amount of care in the service layer makes it one.
 *
 * ## Why two tables for one pack
 *
 * A pack must be two things that cannot both hold on one table: *"written once,
 * never edited, never deleted"* and *"after 72h, the verbatim body is gone"*.
 * Keeping the body in the append-only table would force the retention job to be
 * an **exception** to the append-only rule — and that exception is the attack
 * surface, because whoever can run the job can rewrite the evidence.
 *
 * So the core lives here, never updated and never deleted, and the raw bodies
 * live in `evidence_bodies`, which the job deletes whole rows from. The chain
 * covers the core and the two body **digests**, never the body bytes, which is
 * precisely what lets a body disappear without breaking `content_hash`.
 *
 * ## The four constraints are the design, not decoration
 *
 * - `uq_evidence_packs_verdict` — one pack per verdict, forever. Arbitration
 *   will overturn verdicts; when it does, the answer is a *new* pack pointing
 *   at the old one, not an edit, and this constraint is what forces that
 *   conversation.
 * - `uq_evidence_packs_seq` — no two packs at the same position in an
 *   organization's chain.
 * - `uq_evidence_packs_prev` — **no fork.** Two rows claiming the same
 *   predecessor is how a chain gets rewritten while every individual hash still
 *   verifies. Postgres treats NULLs as distinct here, which is what lets every
 *   organization have its own genesis row.
 * - `chk_evidence_packs_genesis` — `seq = 1` if and only if `prev_hash IS NULL`.
 *   Without it, a row could claim position 1 while naming a predecessor, or sit
 *   at position 40 with the chain silently starting over.
 *
 * ## Why a trigger and not `REVOKE UPDATE`
 *
 * The application connects as the role that owns these tables, so revoking its
 * write privileges either does nothing (owner bypasses) or takes migrations
 * down with it. The trigger refuses the statement itself — from the ORM, from
 * a `psql` session, from a repair script someone writes at 2am — which is the
 * threat actually being defended against. `evidence_bodies` gets the same
 * trigger for `UPDATE` only: deleting a body is the retention policy working,
 * editing one is evidence being rewritten.
 */
export class CreateEvidencePacks1757400000000 implements MigrationInterface {
  name = 'CreateEvidencePacks1757400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "evidence_packs" (
        "id"              uuid        NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now(),
        "version"         integer     NOT NULL DEFAULT 1,
        "organization_id" uuid        NOT NULL,
        "provider_id"     uuid,
        "verdict_id"      uuid        NOT NULL,
        "intent_id"       uuid        NOT NULL,
        "seq"             bigint      NOT NULL,
        "core"            jsonb       NOT NULL,
        "request_sha256"  varchar(71),
        "response_sha256" varchar(71),
        "content_hash"    char(64)    NOT NULL,
        "prev_hash"       char(64),
        "sealed_at"       timestamptz NOT NULL,
        "body_expires_at" timestamptz NOT NULL,
        CONSTRAINT "pk_evidence_packs" PRIMARY KEY ("id"),
        CONSTRAINT "uq_evidence_packs_verdict" UNIQUE ("verdict_id"),
        CONSTRAINT "uq_evidence_packs_seq" UNIQUE ("organization_id", "seq"),
        CONSTRAINT "uq_evidence_packs_prev" UNIQUE ("organization_id", "prev_hash"),
        CONSTRAINT "chk_evidence_packs_content_hash" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "chk_evidence_packs_prev_hash"
          CHECK ("prev_hash" IS NULL OR "prev_hash" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "chk_evidence_packs_genesis" CHECK (("seq" = 1) = ("prev_hash" IS NULL)),
        CONSTRAINT "chk_evidence_packs_seq_positive" CHECK ("seq" >= 1),
        CONSTRAINT "fk_evidence_packs_verdict"
          FOREIGN KEY ("verdict_id") REFERENCES "verification_records" ("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_evidence_packs_organization_id" ON "evidence_packs" ("organization_id")`,
    );

    // The provider's own feed (`GET /providers/me/verdicts/:id/evidence` today,
    // a list once a screen needs one). `provider_id` alone would be a scan over
    // one provider's whole history to answer "the recent ones".
    await queryRunner.query(
      `CREATE INDEX "idx_evidence_packs_provider_feed" ` +
        `ON "evidence_packs" ("provider_id", "sealed_at" DESC) WHERE "provider_id" IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "evidence_bodies" (
        "id"              uuid        NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now(),
        "version"         integer     NOT NULL DEFAULT 1,
        "organization_id" uuid        NOT NULL,
        "pack_id"         uuid        NOT NULL,
        "request"         jsonb,
        "response"        jsonb,
        "expires_at"      timestamptz NOT NULL,
        CONSTRAINT "pk_evidence_bodies" PRIMARY KEY ("id"),
        CONSTRAINT "uq_evidence_bodies_pack" UNIQUE ("pack_id"),
        CONSTRAINT "fk_evidence_bodies_pack"
          FOREIGN KEY ("pack_id") REFERENCES "evidence_packs" ("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_evidence_bodies_organization_id" ON "evidence_bodies" ("organization_id")`,
    );

    // The retention sweep's only query shape: everything already past its
    // deadline, oldest first. Without this it is a sequential scan every hour
    // over a table that only ever grows between sweeps.
    await queryRunner.query(
      `CREATE INDEX "idx_evidence_bodies_expiry" ON "evidence_bodies" ("expires_at")`,
    );

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "evidence_packs_append_only"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'evidence_packs is append-only (attempted %)', TG_OP
          USING ERRCODE = 'raise_exception';
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_evidence_packs_append_only"
        BEFORE UPDATE OR DELETE ON "evidence_packs"
        FOR EACH ROW EXECUTE FUNCTION "evidence_packs_append_only"()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "evidence_bodies_no_update"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'evidence_bodies is append-only; delete the row, never edit it'
          USING ERRCODE = 'raise_exception';
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_evidence_bodies_no_update"
        BEFORE UPDATE ON "evidence_bodies"
        FOR EACH ROW EXECUTE FUNCTION "evidence_bodies_no_update"()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_evidence_bodies_no_update" ON "evidence_bodies"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS "evidence_bodies_no_update"()`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_evidence_packs_append_only" ON "evidence_packs"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS "evidence_packs_append_only"()`);
    await queryRunner.query(`DROP TABLE IF EXISTS "evidence_bodies"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "evidence_packs"`);
  }
}
