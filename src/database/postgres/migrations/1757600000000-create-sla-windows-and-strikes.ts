import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The three tables that turn SLA position from a query into a
 * record.
 *
 * ## What was there before, and why a fold could not stay
 *
 * `ProviderSlaWindowsService` computed a "window" as a rolling UTC calendar day
 * over `payment_intents`, and its own docstring said so: *"**No `sla_windows`
 * table exists.**"* That was the right shape for the first dashboard, which
 * needed a screen to render, and it is the wrong shape for a penalty. Three
 * reasons, in increasing order of how much money they cost:
 *
 * 1. **A calendar day is a boundary the traffic did not choose.** At $0.001 and
 *    a 0.8% sample rate a day holds ~80 quality verdicts, which no honest
 *    statistical claim can be built on; at $1.00 it holds thousands. Two
 *    providers on the same tool were being judged at wildly different
 *    statistical strength for no reason other than their price.
 * 2. **A fold cannot freeze a declaration.** A change to `sla_failure_rate`
 *    must bind *at the next window boundary, never mid-window, and recorded on
 *    the row so a dispute is judged against the declared rate as it was*. Re-reading
 *    `tool_bindings` at query time re-judges all of history against today's
 *    number — including, in the worst case, a number the provider changed after
 *    seeing the verdicts.
 * 3. **A fold has no membership.** A verdict can land minutes or hours after the
 *    call. Deriving "which window is this call in" from `created_at` and a day
 *    boundary silently reassigns late verdicts, so the same window returns
 *    different arithmetic depending on when it is asked. `sla_window_calls`
 *    exists to make that answer immutable: a call is posted to a window once,
 *    and stays there.
 *
 * ## Three tables, and why not one
 *
 * - **`sla_windows`** is the accumulator: one open row per binding, counters,
 *   and the frozen rules it will be judged under.
 * - **`sla_window_calls`** is the append-only membership ledger. It is not a
 *   denormalisation of `payment_intents` — it records a *decision* (this call
 *   was posted to this window) that is not derivable from either table.
 * - **`sla_strikes`** is the window-level breach record, written once, never
 *   updated here, and read by arbitration as the basis for a slash proposal.
 *
 * ## The word "strike" is overloaded, and this migration picks a side
 *
 * "Strike" is used for the per-call consequence of a `FAIL` — *"one strike
 * recorded against the provider's window"* — and `VERDICT_CONSEQUENCE.strike` is
 * that meaning too. It is also used for the window-level event: a strike on a
 * breach, because it is the basis for a slash proposal, and slash proposals
 * come from *"strike or DATA_FAIL"*, which only parses if a strike is something
 * other than a `DATA_FAIL`.
 *
 * So: **`sla_strikes` is the window-level record.** The per-call meaning keeps
 * its existing home on the verdict, and the two are joined through
 * `sla_window_calls`. Nothing here renames anything in the verification domain.
 *
 * ## What is deliberately not here
 *
 * - **No penalty cap.** The per-window `min(formula, max($5, 100 × price))` and
 *   the 10%-of-stake daily cap are enforced on chain against a signed
 *   attestation. `penalty_amount` is the formula result, and a second unsigned
 *   copy of a consensus rule in Postgres is exactly how the two come to
 *   disagree.
 * - **No `MIN_SLASH_PENALTY` carry-forward.** A sub-floor strike is still
 *   recorded; whether it is worth adjudicating yet is a property of the
 *   proposal, which arbitration owns.
 * - **No dispute state.** `status` is `RECORDED` and nothing moves it.
 *   Arbitration adds the transitions and owns that column from then on.
 * - **`sampling_escalation_requested` has no reader.** The rule — a thin
 *   window escalates that binding's sample rate until 400 is reachable, or the
 *   gate becomes a safe harbour for anyone sitting below it — needs the
 *   override threaded into `deriveSampleRate`'s only caller, which is the same
 *   single line `SampleRateOverride.EXPLORING_BINDING` has been waiting on. The
 *   flag is written here so the decision is durable and the seam is named; the
 *   wiring is deferred.
 */
export class CreateSlaWindowsAndStrikes1757600000000 implements MigrationInterface {
  name = 'CreateSlaWindowsAndStrikes1757600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── sla_windows ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "sla_windows" (
        "id"                            uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"                    timestamptz   NOT NULL DEFAULT now(),
        "updated_at"                    timestamptz   NOT NULL DEFAULT now(),
        "version"                       integer       NOT NULL DEFAULT 1,
        "organization_id"               uuid          NOT NULL,
        "provider_id"                   uuid          NOT NULL,
        "binding_id"                    uuid          NOT NULL,
        "tool_id"                       uuid          NOT NULL,
        "sequence"                      integer       NOT NULL,
        "status"                        varchar(16)   NOT NULL,
        "outcome"                       varchar(24),
        "opened_at"                     timestamptz   NOT NULL,
        "deadline_at"                   timestamptz   NOT NULL,
        "closed_at"                     timestamptz,
        "declared_failure_rate"         numeric(6,5)  NOT NULL,
        "min_verified_calls"            integer       NOT NULL,
        "z_score"                       double precision NOT NULL,
        "max_age_ms"                    bigint        NOT NULL,
        "warning_ratio"                 double precision NOT NULL,
        "warning_min_sample_fraction"   double precision NOT NULL,
        "penalty_multiplier"            double precision NOT NULL,
        "total_calls"                   integer       NOT NULL DEFAULT 0,
        "verified_calls"                integer       NOT NULL DEFAULT 0,
        "failed_calls"                  integer       NOT NULL DEFAULT 0,
        "total_call_amount"             numeric(78,0) NOT NULL DEFAULT 0,
        "asset_id"                      varchar(256)  NOT NULL,
        "warning_level"                 varchar(16),
        "warned_at"                     timestamptz,
        "critical_warned_at"            timestamptz,
        "sampling_escalation_requested" boolean       NOT NULL DEFAULT false,
        CONSTRAINT "pk_sla_windows" PRIMARY KEY ("id"),
        CONSTRAINT "fk_sla_windows_binding"
          FOREIGN KEY ("binding_id") REFERENCES "tool_bindings" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_sla_windows_status"
          CHECK ("status" IN ('OPEN', 'CLOSED')),
        CONSTRAINT "chk_sla_windows_outcome"
          CHECK ("outcome" IS NULL OR "outcome" IN
            ('WITHIN_SLA', 'INSUFFICIENT_SAMPLE', 'BREACH_PROPOSED')),
        CONSTRAINT "chk_sla_windows_warning_level"
          CHECK ("warning_level" IS NULL OR "warning_level" IN ('WARNING', 'CRITICAL')),
        -- A closed window has both a time and a verdict, an open one has
        -- neither. Two nullable columns and a status is three ways to say one
        -- thing, and without this they can say it differently.
        CONSTRAINT "chk_sla_windows_closed_consistently" CHECK (
          ("status" = 'OPEN'   AND "closed_at" IS NULL     AND "outcome" IS NULL) OR
          ("status" = 'CLOSED' AND "closed_at" IS NOT NULL AND "outcome" IS NOT NULL)
        ),
        -- The counters are a chain of subsets: every failure is a quality
        -- verdict, every quality verdict is a call. A posting bug that breaks
        -- the chain produces an observed rate above 1, which is a number that
        -- would be shown to a provider on a screen about taking their money.
        CONSTRAINT "chk_sla_windows_counters" CHECK (
          "failed_calls" >= 0 AND
          "failed_calls" <= "verified_calls" AND
          "verified_calls" <= "total_calls"
        ),
        CONSTRAINT "chk_sla_windows_declared_rate"
          CHECK ("declared_failure_rate" >= 0 AND "declared_failure_rate" <= 1),
        CONSTRAINT "chk_sla_windows_sequence" CHECK ("sequence" >= 1)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_sla_windows_organization_id" ON "sla_windows" ("organization_id")`,
    );

    // At most ONE open window per binding. The same argument
    // `uq_provider_stake_grace_open` makes: the posting path is a
    // read-then-write ("is there an open window? no — create one") and two
    // concurrent verification workers finishing calls on the same binding at
    // the same instant is the ordinary case, not the rare one. Two open windows
    // would split one window's traffic in half and put BOTH halves below the
    // sample gate — the exact failure that makes a binding unslashable.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sla_windows_open" ` +
        `ON "sla_windows" ("binding_id") WHERE "status" = 'OPEN'`,
    );

    // The provider-facing name of a window ("w_4482"). Unique per binding so it
    // can be quoted in a dispute without the uuid.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sla_windows_binding_sequence" ` +
        `ON "sla_windows" ("binding_id", "sequence")`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_sla_windows_binding_opened_at" ` +
        `ON "sla_windows" ("binding_id", "opened_at" DESC)`,
    );

    // Drives the peer distribution on the SLA workbench — "median binding on
    // search_web runs 3.1%, p90 at 8.4%" — which reads closed windows across
    // every binding on one tool, deliberately across organizations.
    await queryRunner.query(
      `CREATE INDEX "idx_sla_windows_tool_closed" ` +
        `ON "sla_windows" ("tool_id", "closed_at") WHERE "status" = 'CLOSED'`,
    );

    // The age sweep's only query: open windows past their deadline. Partial, so
    // it stays the size of the open set rather than of all history.
    await queryRunner.query(
      `CREATE INDEX "idx_sla_windows_deadline" ` +
        `ON "sla_windows" ("deadline_at") WHERE "status" = 'OPEN'`,
    );

    // ── sla_window_calls ───────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "sla_window_calls" (
        "id"                 uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"         timestamptz   NOT NULL DEFAULT now(),
        "updated_at"         timestamptz   NOT NULL DEFAULT now(),
        "version"            integer       NOT NULL DEFAULT 1,
        "organization_id"    uuid          NOT NULL,
        "window_id"          uuid          NOT NULL,
        "intent_id"          uuid          NOT NULL,
        "agent_id"           uuid          NOT NULL,
        "verdict"            varchar(32),
        "reason_code"        varchar(64),
        "counted_as_quality" boolean       NOT NULL,
        "counted_as_failure" boolean       NOT NULL,
        "price_amount"       numeric(78,0) NOT NULL,
        "asset_id"           varchar(256)  NOT NULL,
        "posted_at"          timestamptz   NOT NULL,
        CONSTRAINT "pk_sla_window_calls" PRIMARY KEY ("id"),
        CONSTRAINT "fk_sla_window_calls_window"
          FOREIGN KEY ("window_id") REFERENCES "sla_windows" ("id") ON DELETE CASCADE,
        -- A failure is necessarily a quality verdict. Same subset chain as the
        -- counters, enforced at the row so the counters cannot be fed a
        -- combination that would break them.
        CONSTRAINT "chk_sla_window_calls_failure_implies_quality"
          CHECK (NOT "counted_as_failure" OR "counted_as_quality")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_sla_window_calls_organization_id" ` +
        `ON "sla_window_calls" ("organization_id")`,
    );

    // ONE window per call, forever — global, not per window. This is what makes
    // the posting path idempotent under BullMQ's at-least-once delivery: the
    // second delivery of the same verdict fails the insert instead of
    // incrementing a counter twice. A per-window unique index would not do it,
    // because a retry that arrived after the window closed would post the same
    // call to the NEXT window and be accepted.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sla_window_calls_intent" ON "sla_window_calls" ("intent_id")`,
    );

    // The live SLA position's "Recent failures 9 · MIN_ARRAY_LENGTH 6 ·
    // FRESHNESS 3", and the evidence pack's failing-call list.
    await queryRunner.query(
      `CREATE INDEX "idx_sla_window_calls_window_failures" ` +
        `ON "sla_window_calls" ("window_id", "posted_at" DESC) WHERE "counted_as_failure"`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_sla_window_calls_window_posted_at" ` +
        `ON "sla_window_calls" ("window_id", "posted_at")`,
    );

    // ── sla_strikes ────────────────────────────────────────────────────────
    // No soft delete: this is the record a provider's money was taken on the
    // strength of — a deleted payment record is a reconciliation hole.
    await queryRunner.query(`
      CREATE TABLE "sla_strikes" (
        "id"                     uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"             timestamptz   NOT NULL DEFAULT now(),
        "updated_at"             timestamptz   NOT NULL DEFAULT now(),
        "version"                integer       NOT NULL DEFAULT 1,
        "organization_id"        uuid          NOT NULL,
        "provider_id"            uuid          NOT NULL,
        "binding_id"             uuid          NOT NULL,
        "tool_id"                uuid          NOT NULL,
        "window_id"              uuid          NOT NULL,
        "status"                 varchar(24)   NOT NULL DEFAULT 'RECORDED',
        "recorded_at"            timestamptz   NOT NULL,
        "window_opened_at"       timestamptz   NOT NULL,
        "window_closed_at"       timestamptz   NOT NULL,
        "total_calls"            integer       NOT NULL,
        "verified_calls"         integer       NOT NULL,
        "failed_calls"           integer       NOT NULL,
        "observed_rate"          double precision NOT NULL,
        "declared_failure_rate"  numeric(6,5)  NOT NULL,
        "min_verified_calls"     integer       NOT NULL,
        "z_score"                double precision NOT NULL,
        "tolerance"              double precision NOT NULL,
        "effective_threshold"    double precision NOT NULL,
        "excess_rate"            double precision NOT NULL,
        "estimated_bad_calls"    double precision NOT NULL,
        "average_price_amount"   numeric(78,0) NOT NULL,
        "penalty_multiplier"     double precision NOT NULL,
        "penalty_amount"         numeric(78,0) NOT NULL,
        "asset_id"               varchar(256)  NOT NULL,
        "computation"            jsonb         NOT NULL,
        CONSTRAINT "pk_sla_strikes" PRIMARY KEY ("id"),
        -- RESTRICT, not CASCADE: a window that produced a strike must not be
        -- deletable while the strike stands. The strike is the evidence.
        CONSTRAINT "fk_sla_strikes_window"
          FOREIGN KEY ("window_id") REFERENCES "sla_windows" ("id") ON DELETE RESTRICT,
        CONSTRAINT "chk_sla_strikes_status" CHECK ("status" IN ('RECORDED')),
        CONSTRAINT "chk_sla_strikes_counters" CHECK (
          "failed_calls" >= 0 AND
          "failed_calls" <= "verified_calls" AND
          "verified_calls" <= "total_calls" AND
          "verified_calls" >= "min_verified_calls"
        ),
        -- A strike is by definition an observation above the effective
        -- threshold. Writing one that is not would be writing a penalty with no
        -- finding behind it.
        CONSTRAINT "chk_sla_strikes_breached"
          CHECK ("observed_rate" > "effective_threshold"),
        CONSTRAINT "chk_sla_strikes_penalty" CHECK ("penalty_amount" >= 0)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_sla_strikes_organization_id" ON "sla_strikes" ("organization_id")`,
    );

    // ONE strike per window, forever. A window is judged once; a second strike
    // on the same window is a double penalty for one finding, and it is the
    // shape a retried close would take.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sla_strikes_window" ON "sla_strikes" ("window_id")`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_sla_strikes_binding_recorded_at" ` +
        `ON "sla_strikes" ("binding_id", "recorded_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sla_strikes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sla_window_calls"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sla_windows"`);
  }
}
