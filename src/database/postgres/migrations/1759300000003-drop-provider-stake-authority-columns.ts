import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The stake authority leaves `providers`.
 *
 * `1759300000001` created `provider_chain_enrolments` and copied every proved
 * stake authority into it alongside the payout address. This drops the
 * originals, and that is the point rather than tidiness: leaving them would
 * give one provider **two** answers to "whose collateral is slashable for
 * this", and two sources for one identity is a known way to misdirect money.
 * The two would drift the first time a provider proved a stake wallet on a
 * second chain, because a single column cannot hold both, and whichever reader
 * still consulted `providers` would be quietly naming a stake account on the
 * wrong chain — an attestation aimed at an account the settling chain cannot
 * see.
 *
 * The three constraints go with the columns:
 *
 * | dropped from `providers`               | its equivalent on the enrolment                        |
 * |---|---|
 * | `uq_providers_stake_authority`         | `uq_provider_chain_enrolments_stake_authority`          |
 * | `chk_providers_stake_authority_caip10` | `chk_provider_chain_enrolments_stake_caip10`            |
 * | `chk_providers_stake_proved_together`  | `chk_provider_chain_enrolments_stake_proved_together`   |
 *
 * The enrolment also carries `chk_provider_chain_enrolments_stake_on_chain`,
 * which has no equivalent here and could not have had one: a single column with
 * no chain of its own has nothing to be checked against.
 *
 * ## `down()` is lossy, by construction
 *
 * A single-column model cannot represent a provider staked on two chains, so
 * the revert has to pick one. It picks the earliest enrolment, exactly as
 * `1759300000002`'s revert picks the earliest payout address — see the comment
 * on the statement — and it recreates the index and both CHECKs so the reverted
 * schema is the one `1757250000000` left, not a weaker one.
 */
export class DropProviderStakeAuthorityColumns1759300000003 implements MigrationInterface {
  name = 'DropProviderStakeAuthorityColumns1759300000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Before the columns: an index and two CHECKs over columns that are about
    // to stop existing. `DROP COLUMN` would take the index with it anyway, but
    // naming them keeps the revert's job symmetrical and readable.
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_providers_stake_authority"`);
    await queryRunner.query(`
      ALTER TABLE "providers" DROP CONSTRAINT IF EXISTS "chk_providers_stake_authority_caip10"
    `);
    await queryRunner.query(`
      ALTER TABLE "providers" DROP CONSTRAINT IF EXISTS "chk_providers_stake_proved_together"
    `);

    await queryRunner.query(`
      ALTER TABLE "providers"
        DROP COLUMN "stake_authority",
        DROP COLUMN "stake_proof",
        DROP COLUMN "stake_proved_at"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "providers"
        ADD COLUMN "stake_authority" varchar(256),
        ADD COLUMN "stake_proof"     jsonb,
        ADD COLUMN "stake_proved_at" timestamptz
    `);

    // A revert to a single-column model has to pick ONE enrolment, and there is
    // no correct choice when a provider has staked on two chains. The earliest
    // is chosen because it is the one that was there before this plan ran, so a
    // revert on a database that never gained a second chain is exact; on one
    // that did, the reverted schema is lossy by construction and this comment
    // is the record of it.
    //
    // `WHERE stake_authority_account_id IS NOT NULL` inside the subquery and
    // not outside it: `DISTINCT ON` picks the first row per organization in the
    // stated order, so filtering afterwards would silently restore NOTHING for
    // a provider whose earliest enrolment happens to be the unfunded one — the
    // exact case the trio's all-or-nothing CHECK is about.
    await queryRunner.query(`
      UPDATE "providers" p SET
        "stake_authority" = e."stake_authority_account_id",
        "stake_proof"     = e."stake_proof",
        "stake_proved_at" = e."stake_proved_at"
      FROM (
        SELECT DISTINCT ON ("organization_id")
               "organization_id", "stake_authority_account_id", "stake_proof", "stake_proved_at"
        FROM "provider_chain_enrolments"
        WHERE "stake_authority_account_id" IS NOT NULL
        ORDER BY "organization_id", "enrolled_at" ASC
      ) e
      WHERE e."organization_id" = p."organization_id"
    `);

    // Both CHECKs and the index, exactly as `1757000000000` and `1757250000000`
    // wrote them. Recreated in the order they were created in — the format
    // CHECK is the one that makes the unique index mean what it claims, so a
    // revert that restored only the index would restore the weaker guarantee.
    await queryRunner.query(`
      ALTER TABLE "providers" ADD CONSTRAINT "chk_providers_stake_proved_together" CHECK (
        num_nonnulls("stake_authority", "stake_proof", "stake_proved_at") IN (0, 3)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "providers" ADD CONSTRAINT "chk_providers_stake_authority_caip10" CHECK (
        "stake_authority" ~ '^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$'
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_providers_stake_authority"
        ON "providers" ("stake_authority") WHERE "stake_authority" IS NOT NULL
    `);
  }
}
