import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The verifier key directory and the signing journal.
 *
 * Neither table carries `organization_id`. They are two of the handful in this
 * schema that genuinely belong to no tenant: there is one verifier identity per
 * deployment and it signs for the platform. See the entities for the argument.
 *
 * ## The two constraints that are doing real work
 *
 * **`uniq_verifier_signing_keys_active`** — a partial unique index on
 * `state = 'ACTIVE'`. "At most one key signs at a time" is the property the
 * whole rotation rests on, and a rule enforced only in application code is a
 * rule that holds until two operators rotate at once. As an index, the second
 * activation fails with a unique violation instead of producing a directory
 * where "the active key" depends on row order.
 *
 * **`chk_verifier_signing_log_signature_hex`** — a signature is 64 bytes and
 * therefore 128 lowercase hex characters, or it is absent. The column is where
 * an operator would paste something during an incident, and a malformed value
 * here would break the one correlation this journal exists to support.
 *
 * ## Why `verifier_signing_log.key_id` is not a foreign key
 *
 * The journal has to outlive the directory. A key row can be pruned, migrated
 * between custody backends, or exported and re-imported; a signing record from
 * two years ago must still say which key produced it, and an FK would either
 * block that or cascade the history away. The join is by convention and the
 * public key is denormalised onto every row precisely so the join is never
 * required to read the journal.
 */
export class CreateVerifierSigningTables1756500000000 implements MigrationInterface {
  name = 'CreateVerifierSigningTables1756500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "verifier_signing_keys" (
        "id"                    uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"            timestamptz  NOT NULL DEFAULT now(),
        "updated_at"            timestamptz  NOT NULL DEFAULT now(),
        "version"               integer      NOT NULL DEFAULT 1,
        "key_id"                varchar(64)  NOT NULL,
        "backend"               varchar(16)  NOT NULL,
        "backend_ref"           varchar(256) NOT NULL,
        "public_key"            varchar(64)  NOT NULL,
        "chain_address"         varchar(64),
        "state"                 varchar(16)  NOT NULL,
        "registered_expires_at" timestamptz,
        "activated_at"          timestamptz,
        "retired_at"            timestamptz,
        "revoked_at"            timestamptz,
        "reason"                varchar(256),
        CONSTRAINT "pk_verifier_signing_keys"     PRIMARY KEY ("id"),
        CONSTRAINT "uq_verifier_signing_keys_key_id"     UNIQUE ("key_id"),
        CONSTRAINT "uq_verifier_signing_keys_public_key" UNIQUE ("public_key"),
        CONSTRAINT "chk_verifier_signing_keys_state"
          CHECK ("state" IN ('PENDING', 'ACTIVE', 'RETIRED', 'REVOKED')),
        CONSTRAINT "chk_verifier_signing_keys_public_key_hex"
          CHECK ("public_key" ~ '^[0-9a-f]{64}$')
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_verifier_signing_keys_state" ON "verifier_signing_keys" ("state")`,
    );

    // The rotation invariant. See the class comment.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uniq_verifier_signing_keys_active" ` +
        `ON "verifier_signing_keys" (("state")) WHERE "state" = 'ACTIVE'`,
    );

    await queryRunner.query(`
      CREATE TABLE "verifier_signing_log" (
        "id"                  uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"          timestamptz  NOT NULL DEFAULT now(),
        "updated_at"          timestamptz  NOT NULL DEFAULT now(),
        "version"             integer      NOT NULL DEFAULT 1,
        "key_id"              varchar(64)  NOT NULL,
        "public_key"          varchar(64)  NOT NULL,
        "purpose"             varchar(64)  NOT NULL,
        "request_id"          varchar(128),
        "requested_by_type"   varchar(16)  NOT NULL,
        "requested_by_id"     varchar(128) NOT NULL,
        "payload_sha256"      varchar(64)  NOT NULL,
        "signature"           varchar(128),
        "outcome"             varchar(32)  NOT NULL,
        "refusal_reason"      varchar(256),
        "observed_in_window"  integer,
        "completed_at"        timestamptz,
        CONSTRAINT "pk_verifier_signing_log" PRIMARY KEY ("id"),
        CONSTRAINT "chk_verifier_signing_log_outcome"
          CHECK ("outcome" IN (
            'ATTEMPTED', 'SIGNED', 'REFUSED_RATE_LIMIT', 'REFUSED_KEY_NOT_SIGNABLE', 'FAILED'
          )),
        CONSTRAINT "chk_verifier_signing_log_payload_hex"
          CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "chk_verifier_signing_log_signature_hex"
          CHECK ("signature" IS NULL OR "signature" ~ '^[0-9a-f]{128}$')
      )
    `);

    // "Everything this key did, in order" — the investigation query.
    await queryRunner.query(
      `CREATE INDEX "idx_verifier_signing_log_key_created" ` +
        `ON "verifier_signing_log" ("key_id", "created_at")`,
    );
    // "Every signature issued for this request" — the duplicate-attestation query.
    await queryRunner.query(
      `CREATE INDEX "idx_verifier_signing_log_request" ON "verifier_signing_log" ("request_id")`,
    );
    // "Did we sign these exact bytes?" — the one that turns the journal into evidence.
    await queryRunner.query(
      `CREATE INDEX "idx_verifier_signing_log_payload" ` +
        `ON "verifier_signing_log" ("payload_sha256")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "verifier_signing_log"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uniq_verifier_signing_keys_active"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "verifier_signing_keys"`);
  }
}
