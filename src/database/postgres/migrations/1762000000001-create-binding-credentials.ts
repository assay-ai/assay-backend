import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-binding, per-origin credential header sets, envelope-encrypted.
 *
 * The secret values exist only in `ciphertext` (AES-256-GCM under a per-row
 * DEK, itself wrapped by an env-held KEK in `wrapped_dek`). `header_names` and
 * `value_hints` stay readable so the console can list a set without decrypting
 * it. Rows die with their binding.
 */
export class CreateBindingCredentials1762000000001 implements MigrationInterface {
  name = 'CreateBindingCredentials1762000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "binding_credentials" (
        "binding_id"      uuid           NOT NULL,
        "origin"          varchar(2048)  NOT NULL,
        "organization_id" uuid           NOT NULL,
        "kek_id"          varchar(64)    NOT NULL,
        "wrapped_dek"     bytea          NOT NULL,
        "dek_iv"          bytea          NOT NULL,
        "ciphertext"      bytea          NOT NULL,
        "iv"              bytea          NOT NULL,
        "header_names"    varchar(64)[]  NOT NULL,
        "value_hints"     varchar(4)[]   NOT NULL,
        "created_at"      timestamptz    NOT NULL DEFAULT now(),
        "updated_at"      timestamptz    NOT NULL DEFAULT now(),
        "updated_by"      varchar(128)   NOT NULL,
        CONSTRAINT "pk_binding_credentials" PRIMARY KEY ("binding_id", "origin"),
        CONSTRAINT "fk_binding_credentials_binding"
          FOREIGN KEY ("binding_id") REFERENCES "tool_bindings" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_binding_credentials_organization_id" ON "binding_credentials" ("organization_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "binding_credentials"`);
  }
}
