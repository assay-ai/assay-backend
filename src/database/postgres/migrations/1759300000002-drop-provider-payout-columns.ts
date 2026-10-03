import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The payout address leaves `providers`.
 *
 * `1759300000001` created `provider_chain_enrolments` and copied every proved
 * payout address into it. This drops the originals, and that is the point
 * rather than tidiness: leaving them would give one provider **two** answers to
 * "where do I get paid", and two sources for one identity is how an attacker is
 * handed somebody else's money. The two would drift the first time a provider
 * proved an address on a second chain, because a single column cannot hold
 * both, and whichever reader still consulted `providers` would be quietly a
 * chain behind.
 *
 * `chk_providers_payout_proved_together` goes with them; a CHECK over three
 * columns cannot outlive the columns.
 *
 * ## `down()` is lossy, by construction
 *
 * A single-column model cannot represent a provider enrolled on two chains, so
 * the revert has to pick one. It picks the earliest enrolment — see the comment
 * on the statement — and re-adds the constraint in a *tightened* form. Both
 * choices are recorded there rather than here because they are only legible
 * next to the SQL.
 */
export class DropProviderPayoutColumns1759300000002 implements MigrationInterface {
  name = 'DropProviderPayoutColumns1759300000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Before the columns, because the constraint names all three of them.
    await queryRunner.query(`
      ALTER TABLE "providers" DROP CONSTRAINT IF EXISTS "chk_providers_payout_proved_together"
    `);

    await queryRunner.query(`
      ALTER TABLE "providers"
        DROP COLUMN "payout_account_id",
        DROP COLUMN "payout_proof",
        DROP COLUMN "payout_proved_at"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "providers"
        ADD COLUMN "payout_account_id" varchar(256),
        ADD COLUMN "payout_proof"      jsonb,
        ADD COLUMN "payout_proved_at"  timestamptz
    `);

    // A revert to a single-column model has to pick ONE enrolment, and there is
    // no correct choice when a provider has two. The earliest is chosen because
    // it is the one that was there before this plan ran, so a revert on a
    // database that never gained a second chain is exact; on one that did, the
    // reverted schema is lossy by construction and this comment is the record
    // of it.
    await queryRunner.query(`
      UPDATE "providers" p SET
        "payout_account_id" = e."payout_account_id",
        "payout_proof"      = e."payout_proof",
        "payout_proved_at"  = e."payout_proved_at"
      FROM (
        SELECT DISTINCT ON ("organization_id")
               "organization_id", "payout_account_id", "payout_proof", "payout_proved_at"
        FROM "provider_chain_enrolments"
        ORDER BY "organization_id", "enrolled_at" ASC
      ) e
      WHERE e."organization_id" = p."organization_id"
    `);

    // Tightened on the way back: the ORIGINAL constraint tied
    // `payout_account_id` to `payout_proof` and said nothing about
    // `payout_proved_at`. The backfill showed what that costs — a
    // provider in that half-state aborts the enrolment backfill with
    // `null value in column "payout_proved_at"`, naming a COLUMN instead of the
    // provider, and the backfill had to add a pre-flight check just to say who.
    // Recreating the loose version here would re-open exactly that trap on the
    // next forward run. `num_nonnulls` makes the three all-or-nothing, which is
    // what the code always assumed. (Do NOT try to add this in `up()` — `up()`
    // drops all three columns.)
    await queryRunner.query(`
      ALTER TABLE "providers" ADD CONSTRAINT "chk_providers_payout_proved_together"
        CHECK (num_nonnulls("payout_account_id", "payout_proof", "payout_proved_at") IN (0, 3))
    `);
  }
}
