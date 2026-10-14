import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `resolution_kind` may be `CHAIN_ARBITER` on `slash_proposals` and
 * `disputes`: on EVM the arbiter's on-chain `upholdSlash` is the decision on a
 * disputed case (owner decision, 2026-10-14), and the arbiter is a person-held
 * wallet, not an operator row, so the case names no adjudicator and carries no
 * outcome.
 */
export class SlashChainArbiterResolution1760300000000 implements MigrationInterface {
  name = 'SlashChainArbiterResolution1760300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" DROP CONSTRAINT IF EXISTS "chk_slash_proposals_resolution_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ADD CONSTRAINT "chk_slash_proposals_resolution_kind" CHECK (` +
        `"resolution_kind" IS NULL OR "resolution_kind" IN (` +
        `'ADJUDICATOR', 'AUTO_UNDISPUTED', 'AUTO_PLATFORM_MISS', 'AUTO_DE_MINIMIS', ` +
        `'AUTO_CHAIN_VOIDED', 'CHAIN_ARBITER'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "chk_disputes_resolution_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "chk_disputes_resolution_kind" CHECK (` +
        `"resolution_kind" IS NULL OR "resolution_kind" IN (` +
        `'ADJUDICATOR', 'AUTO_PLATFORM_MISS', 'AUTO_CHAIN_EXECUTED', 'CHAIN_ARBITER'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // An arbiter-upheld case reads as undecided again; the chain still holds
    // the ruling, and the watcher writes it back after a re-run of `up`.
    await queryRunner.query(
      `UPDATE "slash_proposals" SET "status" = 'DISPUTED', "resolution_kind" = NULL, ` +
        `"resolved_at" = NULL WHERE "resolution_kind" = 'CHAIN_ARBITER' AND "status" = 'UPHELD'`,
    );
    // Executed since: the money moved, so the case stays closed under the
    // nearest older kind (nobody named on it).
    await queryRunner.query(
      `UPDATE "slash_proposals" SET "resolution_kind" = 'AUTO_UNDISPUTED' ` +
        `WHERE "resolution_kind" = 'CHAIN_ARBITER'`,
    );
    await queryRunner.query(
      `UPDATE "disputes" SET "state" = 'OPEN', "outcome" = NULL, "resolution_kind" = NULL, ` +
        `"resolved_at" = NULL, "resolved_by" = NULL WHERE "resolution_kind" = 'CHAIN_ARBITER'`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" DROP CONSTRAINT IF EXISTS "chk_slash_proposals_resolution_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ADD CONSTRAINT "chk_slash_proposals_resolution_kind" CHECK (` +
        `"resolution_kind" IS NULL OR "resolution_kind" IN (` +
        `'ADJUDICATOR', 'AUTO_UNDISPUTED', 'AUTO_PLATFORM_MISS', 'AUTO_DE_MINIMIS', ` +
        `'AUTO_CHAIN_VOIDED'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "chk_disputes_resolution_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "chk_disputes_resolution_kind" CHECK (` +
        `"resolution_kind" IS NULL OR "resolution_kind" IN (` +
        `'ADJUDICATOR', 'AUTO_PLATFORM_MISS', 'AUTO_CHAIN_EXECUTED'))`,
    );
  }
}
