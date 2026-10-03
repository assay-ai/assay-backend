import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Where a binding's 7-day grace period lives.
 *
 * ## The gate cannot stay binary once stake is real
 *
 * `evaluateStakeGate` is a step function: below the minimum, the binding is not
 * routable, in the same instant. That is safe while stake is a configured
 * stand-in, because a config value does not move on its own. It stops being
 * safe the moment the reading comes off chain, because the settlement program
 * can *reduce* it — one $5 slash against a provider sitting near their floor
 * would take their entire paid traffic offline with no warning and no action on
 * their part.
 *
 * The product forbids exactly that: when stake falls below the minimum a
 * **7-day grace period** runs, **routing continues**, and the provider's screen
 * opens with `Your traffic is still flowing.` A row in this table is that grace
 * period — its start, its deadline, the gap that opened it, and whether it has
 * closed.
 *
 * ## Grace is per binding, and that is not a normalisation choice
 *
 * The requirement is computed per binding — `minimumStakeFor` is
 * `max(floor, priceMultiple × price)` — so one provider's stake is measured
 * against as many different floors as they have bindings. A provider holding
 * $500 is genuinely below the minimum for their $1.00 binding and genuinely
 * above it for their $0.001 binding, at the same instant. A provider-level
 * grace row therefore cannot be right in both directions at once: it would
 * either wave through a binding whose floor is unmet, or cut a binding whose
 * floor is met, and which of the two failures you get depends only on which
 * binding happened to trip the check first.
 *
 * So the row is keyed by `binding_id`, and `organization_id` is carried
 * alongside it for the scope guard rather than as the identity — the same
 * shape `binding_versions` and `binding_test_runs` already use.
 *
 * ## `uq_provider_stake_grace_open` is the clock
 *
 * At most **one open row per binding**, enforced by a partial unique index over
 * `resolved_at IS NULL`. This is not tidiness. The whole value of a grace
 * period is that the clock does not restart: a provider oscillating a few cents
 * around their threshold — which is the *normal* shape of a balance that is
 * being drawn down — would otherwise open a fresh row on every dip and be
 * granted a fresh 7 days each time, which is grace forever and a floor that
 * never binds.
 *
 * Putting that in Postgres rather than in the job that opens the rows matters
 * for the usual reason: "we only ever open one" is a property of code that has
 * not been written yet, and the check that job would make is a read-then-write
 * that two concurrent monitor ticks can interleave through. The index makes the
 * second insert fail instead.
 *
 * Resolving a row — topping up, or the grace expiring — sets `resolved_at` and
 * drops it out of the index, so a *later, separate* dip can open a new period
 * with a new 7 days. That is the intended behaviour: the clock restarts when
 * the provider actually came back above the line, and never while they are
 * still below it.
 *
 * ## What the two amounts are for
 *
 * `required_amount` and `observed_amount` are the reading that opened the
 * period, frozen. The stake screen has to render "the exact amount needed", and
 * deriving it later from today's price and today's balance would answer a
 * different question than the one the countdown is counting down to.
 * `numeric(78,0)` minor units, like every other money column in this schema.
 *
 * ## What this migration deliberately is not
 *
 * Only the table. `applyStakeGrace` — the function that lets a binding inside
 * an open grace period stay routable — and the monitor job that opens and
 * resolves rows are not written yet. Until those land nothing reads or writes
 * here, and the stake gate behaves exactly as it does today.
 */
export class CreateProviderStakeGrace1757100000000 implements MigrationInterface {
  name = 'CreateProviderStakeGrace1757100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "provider_stake_grace" (
        "id"              uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz   NOT NULL DEFAULT now(),
        "updated_at"      timestamptz   NOT NULL DEFAULT now(),
        "version"         integer       NOT NULL DEFAULT 1,
        "organization_id" uuid          NOT NULL,
        "binding_id"      uuid          NOT NULL,
        "started_at"      timestamptz   NOT NULL,
        "expires_at"      timestamptz   NOT NULL,
        "required_amount" numeric(78,0) NOT NULL,
        "observed_amount" numeric(78,0) NOT NULL,
        "resolved_at"     timestamptz,
        CONSTRAINT "pk_provider_stake_grace" PRIMARY KEY ("id"),
        CONSTRAINT "fk_provider_stake_grace_binding"
          FOREIGN KEY ("binding_id") REFERENCES "tool_bindings" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_provider_stake_grace_organization_id" ` +
        `ON "provider_stake_grace" ("organization_id")`,
    );

    // At most ONE open grace row per binding. See the class comment: this is
    // what makes "the clock does not restart" unbreakable rather than merely
    // intended, and it has to be an index because the alternative is a
    // read-then-write in a job that runs on a timer.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_provider_stake_grace_open" ` +
        `ON "provider_stake_grace" ("binding_id") WHERE "resolved_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "provider_stake_grace"`);
  }
}
