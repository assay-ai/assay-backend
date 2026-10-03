import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Due process for taking money: propose, object,
 * adjudicate, reverse. Plus the record of every manual intervention that
 * happens along the way.
 *
 * ## What did not exist before this
 *
 * `sla_strikes` had a producer and no consumer: `SlaWindowService.closeWindow`
 * wrote a row, set `status = 'RECORDED'`, and nothing ever moved it. There was
 * no slash-proposal resource anywhere in `src/`, so the slash-proposal case
 * screen had no route, `NotificationEvent.PROVIDER_SLASH_PROPOSED` had no
 * producer, and the only path from a finding to a penalty was a human running
 * `yarn settlement:exercise`. This migration is where the finding becomes a
 * case with a clock, an owner and an appeal.
 *
 * ## Five tables, and the reason each is its own
 *
 * - **`operators`** — the internal identity the data model has never had.
 *   Every row in the override register is unattributable without it, and the
 *   two-person rule is unimplementable without *two* of them.
 * - **`slash_proposals`** — the case. One per finding, carrying both clocks
 *   (the provider's and ours), the decision, and the chain-side identifiers of
 *   whatever was executed.
 * - **`slash_proposal_events`** — the case timeline the dispute screen renders.
 *   Append-only and wider than the override log on purpose: it holds system
 *   events (proposed, delivered, auto-closed) that are not manual interventions
 *   and must not dilute the override register.
 * - **`override_log_entries`** — the override register itself. Every manual
 *   intervention, permanently, with an actor.
 * - **`fleet_sweeps`** — a platform defect is never a single-provider event;
 *   the sweep is the object that carries one conclusion to every binding the
 *   defect touched, including the providers who never complained.
 *
 * ## Two deliberate departures from `docs/architecture.md`'s scoping rule
 *
 * The rule is that every business table carries `organization_id` and every
 * query filters by it. Two tables here cannot, and saying so out loud is
 * cheaper than a reader discovering it in a query plan:
 *
 * 1. **`operators` has no `organization_id`.** An operator is not a tenant's
 *    user; they are ours. Giving the row a tenant would either invent a fake
 *    "platform" organization — which then appears in every tenant-scoped
 *    aggregate — or imply that an adjudicator belongs to the provider they are
 *    judging.
 * 2. **`override_log_entries.organization_id` is NULLABLE.** It names the
 *    *subject* of the intervention, so a tenant can read their own history; but
 *    killing a policy or rotating a verifier key has no subject tenant, and a
 *    sentinel value there would be a lie in an append-only record.
 *
 * `slash_proposals`, `slash_proposal_events` and `fleet_sweeps.*` rows are
 * organization-scoped normally, on the **provider's** organization —
 * `provider_id == organization_id` for a provider, which the dashboard API
 * already relies on. The operator surface reads across organizations by
 * construction, and does it through a separate guard rather than by weakening
 * the scoped repositories.
 *
 * ## Why the dispute's polarity is the opposite of the proposal's
 *
 * This is the sharpest footgun in the file. `disputes.state = 'UPHELD'` means
 * **the provider's objection** was upheld — the provider won, the penalty is
 * cancelled. `slash_proposals.status = 'UPHELD'` means **the proposal** was
 * upheld — the provider lost, the penalty stands. The two words point in
 * opposite directions and both are the established usage in their own table.
 *
 * The mapping, which is enforced in the service and asserted by a test:
 *
 * ```text
 *   proposal OVERTURNED  ⇔  dispute UPHELD              (provider wins)
 *   proposal UPHELD, recalculated  ⇔  dispute PARTIALLY_UPHELD
 *   proposal UPHELD      ⇔  dispute REJECTED            (provider loses)
 * ```
 *
 * No new `disputes.state` value was needed for the six outcomes, because the
 * six live in their own `outcome` column: six outcomes grouped so a reader
 * still sees "upheld" or "overturned" in half a second.
 *
 * ## The seventh resolution that is not a seventh outcome
 *
 * **If we miss our own deadline the dispute is automatically overturned**, and
 * recorded as our staffing failure rather than the provider's win on the
 * merits. That is not an adjudicator's judgement, so it does not get an
 * adjudicator's outcome code. `resolution_kind` carries it instead: `outcome`
 * is NOT NULL exactly when `resolution_kind = 'ADJUDICATOR'`, and NULL for the
 * three automatic ones. Inventing `OVERTURNED_PLATFORM_MISSED_DEADLINE` as a
 * seventh member would put a decision nobody made into the outcome taxonomy
 * that the false-positive metric reads.
 *
 * ## What is deliberately not here
 *
 * - **No penalty cap, and no split percentages.** Both are on chain (economic
 *   parameters and slash execution), enforced against a signed attestation.
 *   `penalty_amount` is the uncapped formula result copied from the strike;
 *   `applied_amount` is what the chain actually took, written back after the
 *   transaction confirms. A second unsigned copy of a consensus rule in
 *   Postgres is exactly how the two come to disagree — the same reasoning
 *   `1757600000000` gives.
 * - **No de-minimis threshold value.** `WAIVED` is a reachable status and
 *   `SLASH_DE_MINIMIS_MINOR` is config, defaulting to `0` (disabled).
 *   A floor of roughly $25 was considered; every worked example of a slash is
 *   a $5 case, which a $25 floor would erase. Shipping the mechanism with the
 *   floor at zero keeps the screens honest and leaves the number a config
 *   change rather than a migration.
 * - **No policy lifecycle states.** A full
 *   `DRAFT → BACKTEST → SHADOW → CANDIDATE → ACTIVE → SUPERSEDED` lifecycle on
 *   `verification_policies`, which today has two states and is read live by the
 *   verification aggregator, is its own piece of work, not a column here.
 * - **No `adjudication_rubrics` table.** `rubric_version` is a string on the
 *   decision so a case can be re-read under the rubric it was decided by. The
 *   rubric content itself has no author, approver or effective range yet, and
 *   nothing here writes them.
 */
export class SlashProposalsArbitrationAndOverrideLog1757700000000 implements MigrationInterface {
  name = 'SlashProposalsArbitrationAndOverrideLog1757700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── operators ──────────────────────────────────────────────────────────
    //
    // The secret is NOT here. Tokens live in `OPERATOR_CREDENTIALS_FILE` and
    // are matched by digest at request time, exactly as `ConfigMcpSessionSource`
    // does for agents. This table holds the *authority*: which roles the
    // subject has, what they may spend, and whether they are still allowed in
    // at all. A suspended operator is refused even holding a valid token,
    // because revocation must not require editing a file on a box.
    await queryRunner.query(`
      CREATE TABLE "operators" (
        "id"                     uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"             timestamptz   NOT NULL DEFAULT now(),
        "updated_at"             timestamptz   NOT NULL DEFAULT now(),
        "version"                integer       NOT NULL DEFAULT 1,
        "subject"                varchar(256)  NOT NULL,
        "display_name"           varchar(128)  NOT NULL,
        "email"                  varchar(256)  NOT NULL,
        "roles"                  jsonb         NOT NULL DEFAULT '[]'::jsonb,
        "authority_limit_minor"  numeric(78,0),
        "status"                 varchar(16)   NOT NULL DEFAULT 'ACTIVE',
        "suspended_at"           timestamptz,
        "last_seen_at"           timestamptz,
        CONSTRAINT "pk_operators" PRIMARY KEY ("id"),
        CONSTRAINT "chk_operators_status" CHECK ("status" IN ('ACTIVE', 'SUSPENDED')),
        CONSTRAINT "chk_operators_roles_is_array" CHECK (jsonb_typeof("roles") = 'array'),
        -- An operator with no role can authenticate and do nothing. That is a
        -- useful state (onboarding, off-boarding) and not an error.
        CONSTRAINT "chk_operators_suspension_is_whole"
          CHECK (("status" = 'SUSPENDED') = ("suspended_at" IS NOT NULL)),
        CONSTRAINT "chk_operators_authority_non_negative"
          CHECK ("authority_limit_minor" IS NULL OR "authority_limit_minor" >= 0)
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_operators_subject" ON "operators" ("subject")`,
    );

    // ── slash_proposals ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "slash_proposals" (
        "id"                       uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"               timestamptz   NOT NULL DEFAULT now(),
        "updated_at"               timestamptz   NOT NULL DEFAULT now(),
        "version"                  integer       NOT NULL DEFAULT 1,
        "organization_id"          uuid          NOT NULL,
        "provider_id"              uuid          NOT NULL,
        "binding_id"               uuid          NOT NULL,
        "tool_id"                  uuid          NOT NULL,

        -- Where the finding came from. There are exactly two doors:
        -- an SLA strike or a DATA_FAIL verdict becomes a slash proposal.
        "source"                   varchar(16)   NOT NULL,
        "strike_id"                uuid,
        "verdict_id"               uuid,
        "window_id"                uuid,

        "status"                   varchar(24)   NOT NULL,

        -- The chain's replay lock, derived deterministically from "id" so a
        -- retried submission cannot mint a second penalty for one finding.
        -- 32 bytes, lower-case hex.
        "chain_request_id"         char(64)      NOT NULL,

        -- Money. Minor units as strings, per the surface convention.
        "penalty_amount"           numeric(78,0) NOT NULL,
        "applied_amount"           numeric(78,0),
        "asset_id"                 varchar(256)  NOT NULL,
        "decimals"                 integer       NOT NULL,
        "beneficiary_account"      varchar(256),

        -- Both clocks. §3.4: the provider's runs from DELIVERY, not from
        -- issuance — a webhook to a dead endpoint must not eat their window.
        "proposed_at"              timestamptz   NOT NULL,
        "notified_at"              timestamptz,
        "acknowledged_at"          timestamptz,
        "respond_by_at"            timestamptz,
        "platform_decision_due_at" timestamptz,
        "earliest_execution_at"    timestamptz   NOT NULL,

        "disputed_at"              timestamptz,
        "dispute_id"               uuid,

        -- Decision.
        "resolution_kind"          varchar(24),
        "outcome"                  varchar(40),
        "resolved_at"              timestamptz,
        "decided_by_operator_id"   uuid,
        "seconded_by_operator_id"  uuid,
        "seconded_at"              timestamptz,
        "second_kind"              varchar(16),

        -- Execution.
        "executed_at"              timestamptz,
        "execution_signature"      varchar(128),
        "reversed_at"              timestamptz,
        "reversal_signature"       varchar(128),

        -- Batching and sweeps.
        "root_cause_key"           varchar(128),
        "sweep_id"                 uuid,

        -- Feeds the false-positive rate. Derived from the outcome at decision time
        -- and stored, because the taxonomy may grow and a historical rate must
        -- not move when it does.
        "counts_as_false_positive" boolean       NOT NULL DEFAULT false,

        CONSTRAINT "pk_slash_proposals" PRIMARY KEY ("id"),

        CONSTRAINT "chk_slash_proposals_source"
          CHECK ("source" IN ('SLA_STRIKE', 'DATA_FAIL')),

        -- Exactly one door, and it must be the one "source" names. Without the
        -- second half a DATA_FAIL row could carry a strike id and the join
        -- would silently double-count a window.
        CONSTRAINT "chk_slash_proposals_origin_matches_source" CHECK (
          ("source" = 'SLA_STRIKE' AND "strike_id" IS NOT NULL AND "verdict_id" IS NULL)
          OR
          ("source" = 'DATA_FAIL' AND "verdict_id" IS NOT NULL AND "strike_id" IS NULL)
        ),

        CONSTRAINT "chk_slash_proposals_status" CHECK ("status" IN (
          'PROPOSED',
          'DISPUTED',
          'UNDER_REVIEW',
          'AWAITING_SECOND',
          'UPHELD',
          'OVERTURNED',
          'EXECUTING',
          'EXECUTED',
          'REVERSED',
          'WAIVED',
          'CANCELLED'
        )),

        CONSTRAINT "chk_slash_proposals_resolution_kind" CHECK (
          "resolution_kind" IS NULL OR "resolution_kind" IN (
            'ADJUDICATOR', 'AUTO_UNDISPUTED', 'AUTO_PLATFORM_MISS', 'AUTO_DE_MINIMIS'
          )
        ),

        -- The six, and only the six.
        CONSTRAINT "chk_slash_proposals_outcome" CHECK (
          "outcome" IS NULL OR "outcome" IN (
            'UPHELD',
            'UPHELD_RECALCULATED',
            'OVERTURNED_PLATFORM_DEFECT',
            'OVERTURNED_POLICY_DEFECT',
            'OVERTURNED_GRIEFING',
            'OVERTURNED_INSUFFICIENT_EVIDENCE'
          )
        ),

        -- An outcome is what an adjudicator decided. The three automatic
        -- resolutions are decisions nobody made, and must not be readable as
        -- ones — see the header.
        CONSTRAINT "chk_slash_proposals_outcome_needs_adjudicator" CHECK (
          ("resolution_kind" = 'ADJUDICATOR') = ("outcome" IS NOT NULL)
        ),

        CONSTRAINT "chk_slash_proposals_resolution_is_whole" CHECK (
          ("resolved_at" IS NULL) = ("resolution_kind" IS NULL)
        ),

        -- Every adjudicated decision has a named human on it: there is
        -- no path to record a decision without one, lead and admin included.
        CONSTRAINT "chk_slash_proposals_adjudicator_is_named" CHECK (
          "resolution_kind" <> 'ADJUDICATOR' OR "decided_by_operator_id" IS NOT NULL
        ),

        CONSTRAINT "chk_slash_proposals_second_kind" CHECK (
          "second_kind" IS NULL OR "second_kind" IN ('SIGNED', 'OBJECTED')
        ),

        -- The second signature is a second *person*. Enforced in code,
        -- not by the org chart — and here, so that no code path can spend both
        -- identities on one keyboard.
        CONSTRAINT "chk_slash_proposals_second_is_a_different_person" CHECK (
          "seconded_by_operator_id" IS NULL
          OR "seconded_by_operator_id" <> "decided_by_operator_id"
        ),

        CONSTRAINT "chk_slash_proposals_second_is_whole" CHECK (
          ("seconded_at" IS NULL) = ("seconded_by_operator_id" IS NULL)
          AND ("seconded_at" IS NULL) = ("second_kind" IS NULL)
        ),

        CONSTRAINT "chk_slash_proposals_penalty_non_negative"
          CHECK ("penalty_amount" >= 0),

        -- The chain may take less than the formula asked for (the 10%/24h cap,
        -- or a provider holding less than the judgement). It must never take
        -- more.
        CONSTRAINT "chk_slash_proposals_applied_within_penalty" CHECK (
          "applied_amount" IS NULL
          OR ("applied_amount" >= 0 AND "applied_amount" <= "penalty_amount")
        ),

        CONSTRAINT "chk_slash_proposals_executed_is_whole" CHECK (
          ("executed_at" IS NULL) = ("execution_signature" IS NULL)
          AND ("executed_at" IS NULL OR "applied_amount" IS NOT NULL)
        ),

        -- Nothing is reversed that was never executed. The chain refuses this
        -- too (SlashAlreadyReversed / no record); refusing it here means a
        -- reversal bug cannot even be *recorded* as having happened.
        CONSTRAINT "chk_slash_proposals_reversal_needs_execution" CHECK (
          "reversed_at" IS NULL OR "executed_at" IS NOT NULL
        ),

        CONSTRAINT "chk_slash_proposals_reversal_is_whole" CHECK (
          ("reversed_at" IS NULL) = ("reversal_signature" IS NULL)
        ),

        -- A proposal is never executed before its objection deadline, even if
        -- nobody acts. The screen states it as a promise; this states it as a
        -- constraint, so the promise cannot be broken by a service that forgot.
        CONSTRAINT "chk_slash_proposals_execution_respects_timelock" CHECK (
          "executed_at" IS NULL OR "executed_at" >= "earliest_execution_at"
        ),

        CONSTRAINT "chk_slash_proposals_decimals_range"
          CHECK ("decimals" >= 0 AND "decimals" <= 32),

        CONSTRAINT "fk_slash_proposals_strike"
          FOREIGN KEY ("strike_id") REFERENCES "sla_strikes" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_slash_proposals_verdict"
          FOREIGN KEY ("verdict_id") REFERENCES "verification_records" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_slash_proposals_dispute"
          FOREIGN KEY ("dispute_id") REFERENCES "disputes" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_slash_proposals_decided_by"
          FOREIGN KEY ("decided_by_operator_id") REFERENCES "operators" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_slash_proposals_seconded_by"
          FOREIGN KEY ("seconded_by_operator_id") REFERENCES "operators" ("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_slash_proposals_organization_id" ON "slash_proposals" ("organization_id")`,
    );

    // ONE proposal per finding, forever — the same rule `uq_sla_strikes_window`
    // states one level down. A second proposal on one strike is a double
    // penalty for one window, and it is the shape a retried close would take.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_slash_proposals_strike" ON "slash_proposals" ("strike_id") ` +
        `WHERE "strike_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_slash_proposals_verdict" ON "slash_proposals" ("verdict_id") ` +
        `WHERE "verdict_id" IS NOT NULL`,
    );

    // The on-chain lock, mirrored. `slash` burns a request id permanently, so
    // two rows carrying one id would mean the second can never execute and
    // nobody would know why.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_slash_proposals_chain_request_id" ` +
        `ON "slash_proposals" ("chain_request_id")`,
    );

    // The adjudication queue's own ordering: time-to-deadline first, penalty
    // size second, over open cases only. FIFO is wrong — with a hard deadline
    // it guarantees the oldest case expires first.
    await queryRunner.query(
      `CREATE INDEX "idx_slash_proposals_queue" ON "slash_proposals" ` +
        `("platform_decision_due_at" ASC, "penalty_amount" DESC) ` +
        `WHERE "status" IN ('DISPUTED', 'UNDER_REVIEW', 'AWAITING_SECOND')`,
    );

    // The two sweepers: proposals whose provider window has elapsed, and
    // disputes whose *our* window has elapsed.
    await queryRunner.query(
      `CREATE INDEX "idx_slash_proposals_respond_by" ON "slash_proposals" ("respond_by_at") ` +
        `WHERE "status" = 'PROPOSED'`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_slash_proposals_provider_proposed_at" ON "slash_proposals" ` +
        `("provider_id", "proposed_at" DESC)`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_slash_proposals_root_cause" ON "slash_proposals" ("root_cause_key") ` +
        `WHERE "root_cause_key" IS NOT NULL`,
    );

    // ── slash_proposal_events ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "slash_proposal_events" (
        "id"               uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"       timestamptz   NOT NULL DEFAULT now(),
        "updated_at"       timestamptz   NOT NULL DEFAULT now(),
        "version"          integer       NOT NULL DEFAULT 1,
        "organization_id"  uuid          NOT NULL,
        "proposal_id"      uuid          NOT NULL,
        "occurred_at"      timestamptz   NOT NULL,
        "kind"             varchar(48)   NOT NULL,
        "actor_type"       varchar(16)   NOT NULL,
        "actor_id"         varchar(128),
        "summary"          varchar(512)  NOT NULL,
        "detail"           jsonb         NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT "pk_slash_proposal_events" PRIMARY KEY ("id"),
        CONSTRAINT "fk_slash_proposal_events_proposal"
          FOREIGN KEY ("proposal_id") REFERENCES "slash_proposals" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_slash_proposal_events_actor_type"
          CHECK ("actor_type" IN ('provider', 'operator', 'system')),
        -- A system event has no actor; a provider or operator event must name
        -- one. The case timeline renders the actor beside every row.
        CONSTRAINT "chk_slash_proposal_events_actor_is_whole"
          CHECK (("actor_type" = 'system') = ("actor_id" IS NULL))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_slash_proposal_events_organization_id" ` +
        `ON "slash_proposal_events" ("organization_id")`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_slash_proposal_events_proposal_occurred_at" ` +
        `ON "slash_proposal_events" ("proposal_id", "occurred_at" ASC)`,
    );

    // ── override_log_entries ───────────────────────────────────────────────
    //
    // Every override is a compensating action, never a mutation. The
    // register is the record that makes that checkable. Its shape is the
    // PCI-DSS Req. 10.3 baseline — who, what, when, success, source, resource —
    // plus what an override specifically needs: before/after, cause, reason
    // code, maker and checker, break-glass.
    await queryRunner.query(`
      CREATE TABLE "override_log_entries" (
        "id"                     uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"             timestamptz   NOT NULL DEFAULT now(),
        -- Present, and never expected to move: the append-only trigger below
        -- refuses the UPDATE that would change them. They are here so the row
        -- fits AbstractEntityWithoutSoftDelete like every other table, rather
        -- than needing a second base class whose only difference is an absence.
        "updated_at"             timestamptz   NOT NULL DEFAULT now(),
        "version"                integer       NOT NULL DEFAULT 1,

        -- The subject's tenant, when there is one. NULL for platform-wide
        -- actions — see the header.
        "organization_id"        uuid,

        "family"                 char(1)       NOT NULL,
        "code"                   varchar(8)    NOT NULL,
        "action"                 varchar(64)   NOT NULL,

        "actor_operator_id"      uuid          NOT NULL,
        "approver_operator_id"   uuid,
        "approval_mode"          varchar(16)   NOT NULL,

        "target_type"            varchar(32)   NOT NULL,
        "target_id"              varchar(128)  NOT NULL,

        "reason_code"            varchar(64)   NOT NULL,
        "reason"                 text          NOT NULL,

        -- NOT NULL, both of them. "the state before and after" is the whole point;
        -- an entry that records only the new value cannot answer what was
        -- changed, which is the question asked of it.
        "before"                 jsonb         NOT NULL,
        "after"                  jsonb         NOT NULL,

        "ticket_ref"             varchar(128),
        "break_glass"            boolean       NOT NULL DEFAULT false,
        "request_id"             varchar(64),

        CONSTRAINT "pk_override_log_entries" PRIMARY KEY ("id"),

        -- The register's own families: Verification, Policy, Slashing,
        -- Money, Access, Keys.
        CONSTRAINT "chk_override_log_entries_family"
          CHECK ("family" IN ('V', 'P', 'S', 'M', 'A', 'K')),

        -- The code must belong to the family it claims. Catching 'S-3' filed
        -- under 'M' here means the family filter on the console cannot silently
        -- hide a row.
        CONSTRAINT "chk_override_log_entries_code_matches_family"
          CHECK ("code" LIKE "family" || '-%'),

        CONSTRAINT "chk_override_log_entries_approval_mode"
          CHECK ("approval_mode" IN ('SINGLE', 'TWO_PERSON', 'BREAK_GLASS')),

        -- A two-person action without a second identity is a single-person
        -- action wearing its name.
        CONSTRAINT "chk_override_log_entries_two_person_has_approver"
          CHECK ("approval_mode" <> 'TWO_PERSON' OR "approver_operator_id" IS NOT NULL),

        -- §4.1's "no self-approval, enforced in code". Also enforced here,
        -- because code that can be edited is not the same guarantee as a
        -- constraint that refuses the row.
        CONSTRAINT "chk_override_log_entries_no_self_approval"
          CHECK ("approver_operator_id" IS NULL
                 OR "approver_operator_id" <> "actor_operator_id"),

        CONSTRAINT "chk_override_log_entries_break_glass_mode"
          CHECK ("break_glass" = ("approval_mode" = 'BREAK_GLASS')),

        CONSTRAINT "chk_override_log_entries_reason_present"
          CHECK (char_length(btrim("reason")) > 0),

        -- A decision on a case needs a reason code from a
        -- closed list AND a hand-written explanation of at least 120
        -- characters. S-3 is "decide a dispute"; the cheaper rows in the
        -- register do not carry the same burden, and pretending they do would
        -- teach operators to paste filler.
        CONSTRAINT "chk_override_log_entries_decision_reason_length"
          CHECK ("code" <> 'S-3' OR char_length(btrim("reason")) >= 120),

        CONSTRAINT "fk_override_log_entries_actor"
          FOREIGN KEY ("actor_operator_id") REFERENCES "operators" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_override_log_entries_approver"
          FOREIGN KEY ("approver_operator_id") REFERENCES "operators" ("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_override_log_entries_organization_id" ` +
        `ON "override_log_entries" ("organization_id")`,
    );

    // The console's default view, and its three filters.
    await queryRunner.query(
      `CREATE INDEX "idx_override_log_entries_feed" ` +
        `ON "override_log_entries" ("created_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_override_log_entries_actor" ` +
        `ON "override_log_entries" ("actor_operator_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_override_log_entries_target" ` +
        `ON "override_log_entries" ("target_type", "target_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_override_log_entries_family" ` +
        `ON "override_log_entries" ("family", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_override_log_entries_ticket" ON "override_log_entries" ("ticket_ref") ` +
        `WHERE "ticket_ref" IS NOT NULL`,
    );

    // Free-text search over the reason, which is the field an incident review
    // actually greps. `pg_trgm` is not assumed; a GIN over `to_tsvector` needs
    // no extension.
    await queryRunner.query(
      `CREATE INDEX "idx_override_log_entries_reason_fts" ON "override_log_entries" ` +
        `USING gin (to_tsvector('simple', "reason"))`,
    );

    // Append-only, enforced by the database rather than by convention.
    //
    // Every other append-only table in this schema (`ledger_entries`,
    // `evidence_packs`) relies on nobody writing an UPDATE. That is a fine rule
    // and a poor guarantee, and this is the one table whose entire purpose is
    // to be trustworthy when somebody is suspected of something. A trigger is
    // the strongest thing available short of a separate database role, and it
    // costs one function.
    //
    // It does not stop a superuser with `ALTER TABLE ... DISABLE TRIGGER`.
    // Nothing in Postgres does. What it stops is an ORM call, a migration
    // written in a hurry, and a support script — which is every way this table
    // has actually been corrupted anywhere it has been built before.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "override_log_entries_append_only"()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'override_log_entries is append-only: % is refused. Write a compensating entry.',
          TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_override_log_entries_append_only"
      BEFORE UPDATE OR DELETE ON "override_log_entries"
      FOR EACH ROW EXECUTE FUNCTION "override_log_entries_append_only"()
    `);

    // ── fleet_sweeps ───────────────────────────────────────────────────────
    //
    // The sweep is on by default, even for providers who have never complained.
    // A sweep spans providers, so it is not organization-scoped; the proposals
    // it touches are, and they carry `sweep_id` back to it.
    await queryRunner.query(`
      CREATE TABLE "fleet_sweeps" (
        "id"                    uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"            timestamptz   NOT NULL DEFAULT now(),
        "updated_at"            timestamptz   NOT NULL DEFAULT now(),
        "version"               integer       NOT NULL DEFAULT 1,
        "opened_by_operator_id" uuid          NOT NULL,
        "source_proposal_id"    uuid          NOT NULL,
        "outcome"               varchar(40)   NOT NULL,
        "defect_key"            varchar(128)  NOT NULL,
        "window_from"           timestamptz   NOT NULL,
        "window_to"             timestamptz   NOT NULL,
        "status"                varchar(16)   NOT NULL DEFAULT 'OPEN',
        "matched_count"         integer       NOT NULL DEFAULT 0,
        "applied_count"         integer       NOT NULL DEFAULT 0,
        "completed_at"          timestamptz,
        CONSTRAINT "pk_fleet_sweeps" PRIMARY KEY ("id"),
        CONSTRAINT "chk_fleet_sweeps_status" CHECK ("status" IN ('OPEN', 'COMPLETED', 'FAILED')),
        -- Only the two overturns that are statements about *us* sweep. A
        -- griefing finding is about one agent's traffic and an insufficient
        -- sample is about one window; neither generalises to bindings that
        -- never saw them.
        CONSTRAINT "chk_fleet_sweeps_outcome" CHECK (
          "outcome" IN ('OVERTURNED_PLATFORM_DEFECT', 'OVERTURNED_POLICY_DEFECT')
        ),
        CONSTRAINT "chk_fleet_sweeps_window_ordered" CHECK ("window_from" < "window_to"),
        CONSTRAINT "chk_fleet_sweeps_counts" CHECK (
          "matched_count" >= 0 AND "applied_count" >= 0 AND "applied_count" <= "matched_count"
        ),
        CONSTRAINT "chk_fleet_sweeps_completion_is_whole"
          CHECK (("status" = 'COMPLETED') = ("completed_at" IS NOT NULL)),
        CONSTRAINT "fk_fleet_sweeps_opened_by"
          FOREIGN KEY ("opened_by_operator_id") REFERENCES "operators" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_fleet_sweeps_source_proposal"
          FOREIGN KEY ("source_proposal_id") REFERENCES "slash_proposals" ("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_fleet_sweeps_status" ON "fleet_sweeps" ("status", "created_at" DESC)`,
    );

    // The back-reference could not be declared inside `slash_proposals`,
    // because `fleet_sweeps` did not exist yet.
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ADD CONSTRAINT "fk_slash_proposals_sweep" ` +
        `FOREIGN KEY ("sweep_id") REFERENCES "fleet_sweeps" ("id") ON DELETE SET NULL`,
    );

    // ── sla_strikes: hand the status column over ───────────────────────────
    //
    // `1757600000000` wrote `CHECK ("status" IN ('RECORDED'))` and its entity
    // comment says the arbitration work owns the column from here. This is
    // that.
    await queryRunner.query(`ALTER TABLE "sla_strikes" DROP CONSTRAINT "chk_sla_strikes_status"`);
    await queryRunner.query(
      `ALTER TABLE "sla_strikes" ADD CONSTRAINT "chk_sla_strikes_status" ` +
        `CHECK ("status" IN ('RECORDED', 'PROPOSED', 'UPHELD', 'OVERTURNED', 'WAIVED'))`,
    );

    // ── disputes: the columns arbitration needs ────────────────────────────
    //
    // The disputes table already carries claim type, reason, evidence,
    // acknowledgement, deadline and a resolution. What it has never had is an
    // owner, our own deadline, and a decision that is more than a state.
    await queryRunner.query(`
      ALTER TABLE "disputes"
        ADD COLUMN "assigned_operator_id"    uuid,
        ADD COLUMN "assigned_at"             timestamptz,
        ADD COLUMN "platform_due_at"         timestamptz,
        ADD COLUMN "outcome"                 varchar(40),
        ADD COLUMN "reason_codes"            jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN "rubric_version"          varchar(16),
        ADD COLUMN "resolution_kind"         varchar(24),
        ADD COLUMN "seconded_by_operator_id" uuid,
        ADD COLUMN "seconded_at"             timestamptz,
        ADD COLUMN "second_kind"             varchar(16),
        ADD COLUMN "second_note"             varchar(2048)
    `);

    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "fk_disputes_assigned_operator" ` +
        `FOREIGN KEY ("assigned_operator_id") REFERENCES "operators" ("id") ON DELETE RESTRICT`,
    );
    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "fk_disputes_seconded_by" ` +
        `FOREIGN KEY ("seconded_by_operator_id") REFERENCES "operators" ("id") ON DELETE RESTRICT`,
    );

    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "chk_disputes_outcome" CHECK (` +
        `"outcome" IS NULL OR "outcome" IN (` +
        `'UPHELD', 'UPHELD_RECALCULATED', 'OVERTURNED_PLATFORM_DEFECT', ` +
        `'OVERTURNED_POLICY_DEFECT', 'OVERTURNED_GRIEFING', ` +
        `'OVERTURNED_INSUFFICIENT_EVIDENCE'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "chk_disputes_resolution_kind" CHECK (` +
        `"resolution_kind" IS NULL OR "resolution_kind" IN (` +
        `'ADJUDICATOR', 'AUTO_PLATFORM_MISS'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "chk_disputes_second_kind" CHECK (` +
        `"second_kind" IS NULL OR "second_kind" IN ('SIGNED', 'OBJECTED'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "chk_disputes_reason_codes_is_array" ` +
        `CHECK (jsonb_typeof("reason_codes") = 'array')`,
    );
    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "chk_disputes_assignment_is_whole" ` +
        `CHECK (("assigned_at" IS NULL) = ("assigned_operator_id" IS NULL))`,
    );

    // `SLASH_PROPOSAL` joins the three existing subject types. A provider files
    // against the proposal, not the window: the window is a measurement and the
    // proposal is the thing with a clock on it.
    await queryRunner.query(`ALTER TABLE "disputes" DROP CONSTRAINT "chk_disputes_subject_type"`);
    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "chk_disputes_subject_type" ` +
        `CHECK ("subject_type" IN ('SLA_WINDOW', 'VERDICT', 'PAYMENT_INTENT', 'SLASH_PROPOSAL'))`,
    );

    // The queue's ordering index, mirroring the proposal one: time-to-deadline,
    // then penalty size.
    await queryRunner.query(
      `CREATE INDEX "idx_disputes_queue" ON "disputes" ("platform_due_at" ASC) ` +
        `WHERE "state" IN ('OPEN', 'UNDER_REVIEW')`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_disputes_assigned" ON "disputes" ("assigned_operator_id") ` +
        `WHERE "assigned_operator_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_disputes_assigned"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_disputes_queue"`);

    await queryRunner.query(
      `ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "chk_disputes_subject_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "chk_disputes_subject_type" ` +
        `CHECK ("subject_type" IN ('SLA_WINDOW', 'VERDICT', 'PAYMENT_INTENT'))`,
    );

    await queryRunner.query(
      `ALTER TABLE "disputes" ` +
        `DROP CONSTRAINT IF EXISTS "chk_disputes_assignment_is_whole", ` +
        `DROP CONSTRAINT IF EXISTS "chk_disputes_reason_codes_is_array", ` +
        `DROP CONSTRAINT IF EXISTS "chk_disputes_second_kind", ` +
        `DROP CONSTRAINT IF EXISTS "chk_disputes_resolution_kind", ` +
        `DROP CONSTRAINT IF EXISTS "chk_disputes_outcome", ` +
        `DROP CONSTRAINT IF EXISTS "fk_disputes_seconded_by", ` +
        `DROP CONSTRAINT IF EXISTS "fk_disputes_assigned_operator"`,
    );

    await queryRunner.query(`
      ALTER TABLE "disputes"
        DROP COLUMN IF EXISTS "second_note",
        DROP COLUMN IF EXISTS "second_kind",
        DROP COLUMN IF EXISTS "seconded_at",
        DROP COLUMN IF EXISTS "seconded_by_operator_id",
        DROP COLUMN IF EXISTS "resolution_kind",
        DROP COLUMN IF EXISTS "rubric_version",
        DROP COLUMN IF EXISTS "reason_codes",
        DROP COLUMN IF EXISTS "outcome",
        DROP COLUMN IF EXISTS "platform_due_at",
        DROP COLUMN IF EXISTS "assigned_at",
        DROP COLUMN IF EXISTS "assigned_operator_id"
    `);

    await queryRunner.query(
      `ALTER TABLE "sla_strikes" DROP CONSTRAINT IF EXISTS "chk_sla_strikes_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sla_strikes" ADD CONSTRAINT "chk_sla_strikes_status" ` +
        `CHECK ("status" IN ('RECORDED'))`,
    );

    await queryRunner.query(
      `ALTER TABLE "slash_proposals" DROP CONSTRAINT IF EXISTS "fk_slash_proposals_sweep"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "fleet_sweeps"`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_override_log_entries_append_only" ON "override_log_entries"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "override_log_entries"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS "override_log_entries_append_only"()`);
    await queryRunner.query(`DROP TABLE IF EXISTS "slash_proposal_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "slash_proposals"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "operators"`);
  }
}
