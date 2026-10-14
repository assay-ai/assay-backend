import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Operators sign in with a wallet, and two-person actions wait in a queue.
 *
 * ## `operators.wallet_address`
 *
 * An operator is identified by the EVM address they sign the console's
 * sign-in message with — the same way the platform identifies everyone else.
 * Stored lower-case, so `0xAB…` and `0xab…` are one operator, and unique.
 * Nullable while the rows provisioned for the old token file are linked to a
 * wallet (`yarn operator:add --wallet … --subject <existing>`); a row without
 * one simply cannot sign in.
 *
 * ## `REMOVED`
 *
 * An operator who leaves is removed, not deleted: every override-log entry,
 * decision and block references the row. `removed_at` is set exactly when the
 * status is `REMOVED`, the same shape as the suspension pair.
 *
 * ## `operator_approvals`
 *
 * The second person of a two-person action used to be a second bearer token
 * in `X-Operator-Approver`, which meant handing one person's credential to
 * another. Now the action is stored as `PENDING` with the exact payload, and a
 * different operator approves it with their own session; the approval re-runs
 * the action as the requester with the approver recorded. `payload_hash` is the
 * SHA-256 of the canonical payload, checked again before it is re-run.
 */
export class OperatorWalletSignInAndApprovals1760100000000 implements MigrationInterface {
  name = 'OperatorWalletSignInAndApprovals1760100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "operators" ADD "wallet_address" varchar(42)`);
    await queryRunner.query(`ALTER TABLE "operators" ADD "removed_at" timestamptz`);
    await queryRunner.query(
      `ALTER TABLE "operators" ADD CONSTRAINT "chk_operators_wallet_address"
         CHECK ("wallet_address" IS NULL OR "wallet_address" ~ '^0x[0-9a-f]{40}$')`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_operators_wallet_address" ON "operators" ("wallet_address")`,
    );
    await queryRunner.query(`ALTER TABLE "operators" DROP CONSTRAINT "chk_operators_status"`);
    await queryRunner.query(
      `ALTER TABLE "operators" ADD CONSTRAINT "chk_operators_status"
         CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'REMOVED'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "operators" ADD CONSTRAINT "chk_operators_removal_is_whole"
         CHECK (("status" = 'REMOVED') = ("removed_at" IS NOT NULL))`,
    );

    await queryRunner.query(`
      CREATE TABLE "operator_approvals" (
        "id"            uuid          NOT NULL DEFAULT gen_random_uuid(),
        "action"        varchar(64)   NOT NULL,
        "target"        varchar(128)  NOT NULL,
        "payload"       jsonb         NOT NULL,
        "payload_hash"  varchar(64)   NOT NULL,
        "requested_by"  uuid          NOT NULL,
        "approved_by"   uuid,
        "rejected_by"   uuid,
        "status"        varchar(16)   NOT NULL DEFAULT 'PENDING',
        "created_at"    timestamptz   NOT NULL DEFAULT now(),
        "decided_at"    timestamptz,
        "expires_at"    timestamptz   NOT NULL,
        CONSTRAINT "pk_operator_approvals" PRIMARY KEY ("id"),
        CONSTRAINT "chk_operator_approvals_status"
          CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
        CONSTRAINT "chk_operator_approvals_decided"
          CHECK (("status" = 'PENDING') = ("decided_at" IS NULL)),
        CONSTRAINT "chk_operator_approvals_approved_by"
          CHECK (("status" = 'APPROVED') = ("approved_by" IS NOT NULL)),
        CONSTRAINT "chk_operator_approvals_rejected_by"
          CHECK (("status" = 'REJECTED') = ("rejected_by" IS NOT NULL)),
        CONSTRAINT "chk_operator_approvals_no_self_approval"
          CHECK ("approved_by" IS NULL OR "approved_by" <> "requested_by"),
        CONSTRAINT "fk_operator_approvals_requested_by"
          FOREIGN KEY ("requested_by") REFERENCES "operators" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_operator_approvals_approved_by"
          FOREIGN KEY ("approved_by") REFERENCES "operators" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_operator_approvals_rejected_by"
          FOREIGN KEY ("rejected_by") REFERENCES "operators" ("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_operator_approvals_status_created"
         ON "operator_approvals" ("status", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "operator_approvals"`);
    await queryRunner.query(
      `ALTER TABLE "operators" DROP CONSTRAINT IF EXISTS "chk_operators_removal_is_whole"`,
    );
    await queryRunner.query(`ALTER TABLE "operators" DROP CONSTRAINT "chk_operators_status"`);
    await queryRunner.query(
      `ALTER TABLE "operators" ADD CONSTRAINT "chk_operators_status"
         CHECK ("status" IN ('ACTIVE', 'SUSPENDED'))`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_operators_wallet_address"`);
    await queryRunner.query(
      `ALTER TABLE "operators" DROP CONSTRAINT IF EXISTS "chk_operators_wallet_address"`,
    );
    await queryRunner.query(`ALTER TABLE "operators" DROP COLUMN "removed_at"`);
    await queryRunner.query(`ALTER TABLE "operators" DROP COLUMN "wallet_address"`);
  }
}
