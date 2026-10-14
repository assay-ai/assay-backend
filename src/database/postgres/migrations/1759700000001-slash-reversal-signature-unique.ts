import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One deposit compensates one case (security review M-3).
 *
 * `markCompensated` checks the deposit on chain, but nothing stopped the same
 * treasury deposit being recorded against two cases. A partial unique index on
 * `reversal_signature` (NULL for every case not compensated) closes that.
 *
 * Existing rows are checked first: if two cases already share a signature the
 * migration stops and names them, rather than failing on a bare unique
 * violation. Decide which case the deposit really compensated, then clear the
 * other row's `reversal_signature` (and re-open it) before re-running.
 */
export class SlashReversalSignatureUnique1759700000001 implements MigrationInterface {
  name = 'SlashReversalSignatureUnique1759700000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const duplicates: { reversal_signature: string; ids: string[] }[] = await queryRunner.query(`
      SELECT "reversal_signature", array_agg("id"::text ORDER BY "id") AS "ids"
        FROM "slash_proposals"
       WHERE "reversal_signature" IS NOT NULL
       GROUP BY "reversal_signature"
      HAVING count(*) > 1
    `);
    if (duplicates.length > 0) {
      const list = duplicates
        .map((row) => `${row.reversal_signature}: ${row.ids.join(', ')}`)
        .join('; ');
      throw new Error(
        `slash_proposals: one compensation deposit is recorded on several cases (${list}). ` +
          `Resolve these rows before adding uq_slash_proposals_reversal_signature.`,
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_slash_proposals_reversal_signature"
        ON "slash_proposals" ("reversal_signature")
        WHERE "reversal_signature" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_slash_proposals_reversal_signature"`);
  }
}
