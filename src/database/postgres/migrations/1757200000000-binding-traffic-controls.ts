import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The columns behind a provider regulating their own traffic.
 *
 * Three things a provider can do to the flow arriving at their endpoint, and
 * none of them is a change to what a call *does*:
 *
 * ```text
 * max_rps / max_daily_calls   declared ceilings — shed, don't fail
 * pause_reason / paused_at    the pause button, and who pressed it
 * payment_intents.binding_id  what makes the exploration floor countable
 * ```
 *
 * Schema only. The token bucket, the pause service, the exploration floor and
 * the router wiring are later tasks in this goal; until they land nothing reads
 * or writes any of these columns and routing behaves exactly as it does today.
 *
 * ## Why the ceilings shed instead of letting the calls fail
 *
 * A provider reselling a metered upstream has a real limit, and today we do not
 * know it. So we route into it, the upstream returns `429`, and the failure
 * lands on the provider's own availability score — a limit they declared
 * nowhere being punished as if it were an outage — *"fine on day 27 and dead on
 * day 28"*. Declaring the ceiling turns the same event into a routing decision
 * taken **before** the call, which is a shed with a reason (`CeilingKind`,
 * already in `routing.types.ts`) rather than an attempt that failed.
 *
 * Both are nullable and both mean "no ceiling declared". That is not the same
 * as `0`, which would mean a provider had declared themselves unroutable — and
 * a provider who wants that has `PAUSED`.
 *
 * ## `max_daily_calls`, never `daily_call_quota`
 *
 * "Quota" is spoken for in this codebase and it means the **agent's** free-tier
 * allowance: `free_quota_per_agent` and `free_daily_budget` sit two columns up
 * in this very table, and `McpErrors.quotaExceeded` renders as *"Free-tier
 * quota exceeded"*. This ceiling belongs to the **provider** — the opposite
 * party to the one every existing use of the word describes. Two meanings of
 * "quota" on one row is a bug waiting for the first person who reads the wrong
 * one. The field is named `maxDailyCalls` and `CeilingKind.MAX_DAILY_CALLS`
 * already exists.
 *
 * ## `pause_reason` exists now, and adding it later would have been a guess
 *
 * `PAUSED` already has two causes and they have opposite consequences.
 * `IneligibilityReason.BINDING_NOT_ACTIVE` documents its own as *"`PAUSED`
 * (circuit open)"* — the SLA health breaker, which will write this status
 * because something went wrong. A manual pause is the provider's own hand on
 * their own traffic: **no penalty, no mark in the quality profile**, because
 * choosing not to serve is not the same as failing to serve.
 *
 * One value for two causes means the SLA monitor cannot tell them apart, and
 * neither can the screen that shows a provider why their traffic stopped. It
 * has to be recorded at the moment of pausing, because it is not recoverable
 * afterwards: a `PAUSED` row six weeks old carries no trace of which of the two
 * put it there, so a column added later could only be backfilled by inventing
 * an answer. Hence `chk_tool_bindings_pause_attributed` — a biconditional, so a
 * pause can never be unattributed *and* a reason can never linger on a binding
 * that is serving again.
 *
 * No CHECK on the *values* yet. The vocabulary belongs to the service that
 * writes them, and a constraint enumerating members nobody has chosen would be
 * a guess enforced by Postgres. `varchar(24)` matches `payment_intents.status`
 * and the other short enum columns.
 *
 * ### The backfill runs BEFORE the constraint, and that order is the argument
 *
 * Any environment already holding a `PAUSED` binding holds one with no recorded
 * cause — which is exactly the gap this column exists to close. Adding the
 * constraint first would make `ADD CONSTRAINT` fail on precisely those
 * environments. They are attributed to `PLATFORM`, which is the truthful
 * reading: before this migration no provider-facing pause control existed, so
 * every pause in the wild was ours.
 *
 * ## `payment_intents.binding_id`, nullable and deliberately not backfilled
 *
 * The exploration floor is *"the first 1,000 calls of a binding"*, so something
 * has to be able to count calls per binding. Today `payment_intents` carries
 * `tool_id` and `provider_id` and no binding, which means the count can only be
 * reached by joining through `uq_tool_bindings_organization_tool` — true today,
 * and an incidental uniqueness constraint doing load-bearing work that a future
 * multi-binding-per-tool decision would silently break.
 *
 * Old rows stay `NULL`. The join *would* resolve them, but writing the result
 * down would record a fact nobody observed at the time: it would say "this call
 * went to binding X" on the authority of what the table looks like now, and a
 * provider disputing an exploration count months later cannot tell an inferred
 * value from a measured one. `NULL` says "we did not record this", which is
 * both true and distinguishable.
 *
 * The index is `(binding_id, created_at)` because every read is a window: the
 * first N calls of a binding, or a binding's calls within a day.
 */
export class BindingTrafficControls1757200000000 implements MigrationInterface {
  name = 'BindingTrafficControls1757200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tool_bindings"
        ADD COLUMN "max_rps"         int,
        ADD COLUMN "max_daily_calls" int,
        ADD COLUMN "pause_reason"    varchar(24),
        ADD COLUMN "paused_at"       timestamptz
    `);

    // MUST run BEFORE the ADD CONSTRAINT below. Existing `PAUSED` rows have no
    // recorded cause — which is the whole argument for the column existing —
    // so a constraint added first would fail on any environment holding one.
    await queryRunner.query(`
      UPDATE "tool_bindings"
         SET "pause_reason" = 'PLATFORM',
             "paused_at"    = COALESCE("paused_at", "updated_at")
       WHERE "status" = 'PAUSED'
    `);

    await queryRunner.query(`
      ALTER TABLE "tool_bindings"
        ADD CONSTRAINT "chk_tool_bindings_pause_attributed"
        CHECK (("status" = 'PAUSED') = ("pause_reason" IS NOT NULL))
    `);

    await queryRunner.query(`ALTER TABLE "payment_intents" ADD COLUMN "binding_id" uuid`);

    // No foreign key, for the reason `provider_id` has none: an intent is a
    // financial record and must outlive anything it names.
    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_binding" ` +
        `ON "payment_intents" ("binding_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_binding"`);
    await queryRunner.query(`ALTER TABLE "payment_intents" DROP COLUMN IF EXISTS "binding_id"`);

    await queryRunner.query(
      `ALTER TABLE "tool_bindings" DROP CONSTRAINT IF EXISTS "chk_tool_bindings_pause_attributed"`,
    );
    await queryRunner.query(`
      ALTER TABLE "tool_bindings"
        DROP COLUMN IF EXISTS "paused_at",
        DROP COLUMN IF EXISTS "pause_reason",
        DROP COLUMN IF EXISTS "max_daily_calls",
        DROP COLUMN IF EXISTS "max_rps"
    `);
  }
}
