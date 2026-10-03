import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lean v3 — a slash proposal can now be *waiting on the admin's signature*.
 *
 * `cancel_slash` used to be signed by any active verifier, which meant this
 * backend could withdraw a standing judgement inside the same request that
 * decided to. Lean v3 makes `Config.admin` its only signer — a person's
 * hardware key that no service here holds — so an overturn, a platform-miss
 * sweep or a downward recalculation can only *record* that the reservation
 * should go and wait for a human to sign the transaction
 * `POST /operator/cases/:id/cancel-intent` builds.
 *
 * `CANCEL_REQUESTED` is that wait, and it is a distinct `chain_status` rather
 * than a flag for one reason: `findChainExecutable`'s predicate is
 * `chain_status = 'PENDING'`, so a case in this state falls out of the execute
 * sweep by construction. A boolean beside `PENDING` would have needed every
 * one of those predicates edited to honour it, and the first one missed would
 * execute a judgement this platform had already withdrawn.
 *
 * Sixteen characters exactly, which `varchar(16)` holds without widening.
 *
 * `chk_slash_proposals_chain_pending_is_whole` is deliberately **not** extended
 * to cover the new value. It requires both chain clocks on `PENDING` and
 * `EXECUTED`; a `CANCEL_REQUESTED` row was `PENDING` a moment earlier and
 * carries them already, and adding the value to that CHECK would refuse the
 * update rather than assert anything new.
 */
export class SlashProposalsCancelRequested1759200000001 implements MigrationInterface {
  name = 'SlashProposalsCancelRequested1759200000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        DROP CONSTRAINT IF EXISTS "chk_slash_proposals_chain_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD CONSTRAINT "chk_slash_proposals_chain_status" CHECK ("chain_status" IN (
          'NONE', 'PROPOSING', 'PENDING', 'CANCEL_REQUESTED', 'EXECUTED', 'CANCELLED', 'REFUSED'
        ))
    `);

    // The sweep that carries a request through to the chain reads exactly these
    // rows once a minute. Without the partial index it is a sequential scan of
    // every slash proposal ever written, on a table that only grows.
    await queryRunner.query(`
      CREATE INDEX "idx_slash_proposals_awaiting_admin_cancel"
        ON "slash_proposals" ("chain_executable_at")
        WHERE "chain_status" = 'CANCEL_REQUESTED'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_slash_proposals_awaiting_admin_cancel"`);
    // Any row still waiting on the admin goes back to the state it was in
    // before the request: the record really is `Pending` on chain, and
    // `PENDING` is the honest mirror of that. It re-enters the execute sweep,
    // which is what the pre-lean-v3 code did with it anyway.
    await queryRunner.query(`
      UPDATE "slash_proposals" SET "chain_status" = 'PENDING'
        WHERE "chain_status" = 'CANCEL_REQUESTED'
    `);
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        DROP CONSTRAINT IF EXISTS "chk_slash_proposals_chain_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD CONSTRAINT "chk_slash_proposals_chain_status" CHECK ("chain_status" IN (
          'NONE', 'PROPOSING', 'PENDING', 'EXECUTED', 'CANCELLED', 'REFUSED'
        ))
    `);
  }
}
