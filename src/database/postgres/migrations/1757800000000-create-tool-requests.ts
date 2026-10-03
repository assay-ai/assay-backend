import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The tool request queue.
 *
 * ## Why this is one small table and not a proposal workflow
 *
 * The scope is deliberately small:
 *
 * > At MVP this is a form that creates a ticket with a named owner and a
 * > two-working-day first response, and a page that says plainly that we author
 * > tools today and how long that takes. **Do not ship a proposal workflow
 * > before the reviewers exist.** A provider who writes a schema and hears
 * > nothing is a worse outcome than one who was told no.
 *
 * So there is no submitted schema, no review round, no revision history and no
 * accept-into-catalogue path. Those are the Phase 2 half of the same screen and
 * they need a reviewer role that does not exist. What this table holds is a
 * request, an owner, and a clock that proves the owner answered.
 *
 * ## The one column that carries the promise
 *
 * `first_response_due_at` is written **at insert**, not derived at read time.
 * The commitment in the copy is two working days from when the request was
 * filed, and a due date computed on read would silently move every time the
 * working-day calendar or the timezone rule changed. Stored, it is a promise
 * with a date on it; derived, it is a rendering detail. `first_responded_at`
 * is the other half — the two together are the only measurement of whether the
 * commitment was kept, and neither is recoverable after the fact.
 *
 * `first_responded_at` is set by the first transition out of `OPEN` and never
 * cleared, which is why it is not folded into `status`: a request that went
 * `OPEN → ACKNOWLEDGED → DECLINED` was answered once, on the first transition,
 * and a status column can only remember the last one.
 *
 * ## Scoping
 *
 * `organization_id` is the **requester's** org, and it is the caller's own
 * tenant on every route — unlike `payment_intents` and `verification_records`,
 * where it is the payer's org and a provider reads by `provider_id` instead
 * (see `ProviderVerdictsController`). A tool request has one party. There is no
 * second identity on the row and no cross-tenant read.
 *
 * `owner_operator_id` references `operators` rather than naming a person in a
 * varchar. An owner who has left is then a foreign key that still resolves to
 * who they were, and "named owner" in the copy above means an actual row rather
 * than a string somebody typed.
 */
export class CreateToolRequests1757800000000 implements MigrationInterface {
  name = 'CreateToolRequests1757800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "tool_requests" (
        "id"                    uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"            timestamptz   NOT NULL DEFAULT now(),
        "updated_at"            timestamptz   NOT NULL DEFAULT now(),
        "version"               integer       NOT NULL DEFAULT 1,
        "organization_id"       uuid          NOT NULL,
        "requested_by_agent_id" uuid,
        "title"                 varchar(160)  NOT NULL,
        "description"           text          NOT NULL,
        "upstream_url"          varchar(2048),
        "expected_monthly_calls" integer,
        "status"                varchar(16)   NOT NULL DEFAULT 'OPEN',
        "owner_operator_id"     uuid,
        "first_response_due_at" timestamptz   NOT NULL,
        "first_responded_at"    timestamptz,
        "resolution_note"       text,
        "closed_at"             timestamptz,
        CONSTRAINT "pk_tool_requests" PRIMARY KEY ("id"),
        CONSTRAINT "fk_tool_requests_owner"
          FOREIGN KEY ("owner_operator_id") REFERENCES "operators" ("id") ON DELETE SET NULL,
        CONSTRAINT "chk_tool_requests_status"
          CHECK ("status" IN ('OPEN', 'ACKNOWLEDGED', 'ACCEPTED', 'DECLINED')),
        -- A request that has left OPEN was answered, and the time it was
        -- answered is the whole point of the queue. Without this, a status can
        -- advance while the clock that measures the promise stays null, and the
        -- SLA on the screen becomes unfalsifiable.
        CONSTRAINT "chk_tool_requests_answered_is_timed" CHECK (
          ("status" = 'OPEN' AND "first_responded_at" IS NULL) OR
          ("status" <> 'OPEN' AND "first_responded_at" IS NOT NULL)
        ),
        -- ACCEPTED and DECLINED are terminal and carry a reason; ACKNOWLEDGED
        -- is not terminal and must not pretend to be by holding a closed_at.
        CONSTRAINT "chk_tool_requests_closed_is_whole" CHECK (
          ("status" IN ('ACCEPTED', 'DECLINED')
             AND "closed_at" IS NOT NULL AND "resolution_note" IS NOT NULL) OR
          ("status" IN ('OPEN', 'ACKNOWLEDGED')
             AND "closed_at" IS NULL)
        ),
        CONSTRAINT "chk_tool_requests_expected_calls"
          CHECK ("expected_monthly_calls" IS NULL OR "expected_monthly_calls" >= 0)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_tool_requests_organization_id" ` +
        `ON "tool_requests" ("organization_id", "created_at")`,
    );

    // The queue view an operator opens: everything still owed a first response,
    // oldest first. Partial, because a closed request is never in that view and
    // the open set stays small while the table does not.
    await queryRunner.query(
      `CREATE INDEX "idx_tool_requests_awaiting_response" ` +
        `ON "tool_requests" ("first_response_due_at") ` +
        `WHERE "first_responded_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tool_requests_awaiting_response"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tool_requests_organization_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tool_requests"`);
  }
}
