import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The account blocklist: one row per block of an organization or a wallet.
 *
 * See `AccountBlockEntity` for why this is a table and not
 * `organizations.status`. The constraints carry the rules the service relies
 * on, so a hand-written `UPDATE` cannot produce a state the cache would read
 * wrongly:
 *
 * - one active block per subject key (`uq_account_blocks_active`), so a second
 *   block of a blocked subject is refused rather than stacked;
 * - a lifting is all-or-nothing (`chk_account_blocks_unblock_complete`) and is
 *   approved by somebody other than the operator who lifted it
 *   (`chk_account_blocks_unblock_two_person`) — `A-10` is two-person.
 *
 * `idx_account_blocks_active` is the partial index every process's refresh
 * reads, every few seconds; it holds only the rows that are blocking now.
 */
export class AccountBlocks1759800000000 implements MigrationInterface {
  name = 'AccountBlocks1759800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "account_blocks" (
        "id"                  uuid          NOT NULL DEFAULT gen_random_uuid(),
        "subject_kind"        varchar(16)   NOT NULL,
        "subject"             varchar(256)  NOT NULL,
        "subject_key"         varchar(256)  NOT NULL,
        "reason_code"         varchar(64)   NOT NULL,
        "note"                text          NOT NULL,
        "ticket_ref"          varchar(128),
        "blocked_by"          uuid          NOT NULL,
        "blocked_at"          timestamptz   NOT NULL DEFAULT now(),
        "unblocked_by"        uuid,
        "unblock_approved_by" uuid,
        "unblocked_at"        timestamptz,
        "unblock_note"        text,
        "created_at"          timestamptz   NOT NULL DEFAULT now(),
        "updated_at"          timestamptz   NOT NULL DEFAULT now(),
        "version"             integer       NOT NULL DEFAULT 1,
        CONSTRAINT "pk_account_blocks" PRIMARY KEY ("id"),
        CONSTRAINT "chk_account_blocks_subject_kind"
          CHECK ("subject_kind" IN ('ORGANIZATION', 'WALLET')),
        CONSTRAINT "chk_account_blocks_note" CHECK (length(btrim("note")) >= 20),
        CONSTRAINT "chk_account_blocks_unblock_complete" CHECK (
          ("unblocked_at" IS NULL AND "unblocked_by" IS NULL
             AND "unblock_approved_by" IS NULL AND "unblock_note" IS NULL)
          OR ("unblocked_at" IS NOT NULL AND "unblocked_by" IS NOT NULL
             AND "unblock_approved_by" IS NOT NULL AND "unblock_note" IS NOT NULL)
        ),
        CONSTRAINT "chk_account_blocks_unblock_two_person"
          CHECK ("unblock_approved_by" IS NULL OR "unblock_approved_by" <> "unblocked_by"),
        CONSTRAINT "fk_account_blocks_blocked_by"
          FOREIGN KEY ("blocked_by") REFERENCES "operators" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_account_blocks_unblocked_by"
          FOREIGN KEY ("unblocked_by") REFERENCES "operators" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_account_blocks_unblock_approved_by"
          FOREIGN KEY ("unblock_approved_by") REFERENCES "operators" ("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_account_blocks_active"
        ON "account_blocks" ("subject_kind", "subject_key")
        WHERE "unblocked_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_account_blocks_active"
        ON "account_blocks" ("subject_kind")
        INCLUDE ("subject_key", "subject", "reason_code", "blocked_at")
        WHERE "unblocked_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_account_blocks_feed" ON "account_blocks" ("blocked_at", "id")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_account_blocks_subject" ON "account_blocks" ("subject_key")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "account_blocks"`);
  }
}
