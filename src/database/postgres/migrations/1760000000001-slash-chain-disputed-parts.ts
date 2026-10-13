import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A dispute freezes only the part it names (audit E-4).
 *
 * `slash_proposals.chain_disputed_parts` counts the current epoch's parts that
 * are `DISPUTED` on chain, so the case mirror can stay honest while it stays
 * `PENDING` for its undisputed parts: `chain_status = 'DISPUTED'` now means
 * EVERY live part is disputed, and `PENDING` with a non-zero count means the
 * case is partly disputed and its other parts keep executing.
 *
 * The backfill repairs cases frozen by the old rule: a `DISPUTED` mirror with
 * a part still `PENDING` goes back to `PENDING`, so the execute sweep sees it.
 */
export class SlashChainDisputedParts1760000000001 implements MigrationInterface {
  name = 'SlashChainDisputedParts1760000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "slash_proposals"
         ADD COLUMN "chain_disputed_parts" integer NOT NULL DEFAULT 0,
         ADD CONSTRAINT "chk_slash_proposals_chain_disputed_parts" CHECK ("chain_disputed_parts" >= 0)`,
    );
    await queryRunner.query(`
      UPDATE "slash_proposals" p
         SET "chain_disputed_parts" = counted.n
        FROM (
          SELECT part.proposal_id, count(*)::int AS n
            FROM "slash_proposal_parts" part
            JOIN "slash_proposals" c ON c.id = part.proposal_id AND c.chain_epoch = part.chain_epoch
           WHERE part.chain_status = 'DISPUTED'
           GROUP BY part.proposal_id
        ) counted
       WHERE p.id = counted.proposal_id
    `);
    await queryRunner.query(`
      UPDATE "slash_proposals" p
         SET "chain_status" = 'PENDING'
       WHERE p.chain_status = 'DISPUTED'
         AND EXISTS (
           SELECT 1 FROM "slash_proposal_parts" part
            WHERE part.proposal_id = p.id
              AND part.chain_epoch = p.chain_epoch
              AND part.chain_status = 'PENDING'
         )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "slash_proposals" SET "chain_status" = 'DISPUTED'
       WHERE "chain_status" = 'PENDING' AND "chain_disputed_parts" > 0
    `);
    await queryRunner.query(
      `ALTER TABLE "slash_proposals"
         DROP CONSTRAINT IF EXISTS "chk_slash_proposals_chain_disputed_parts",
         DROP COLUMN "chain_disputed_parts"`,
    );
  }
}
