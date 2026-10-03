import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The keyset indexes the "Calls, receipts, and account" endpoint
 * group needs and the schema did not have.
 *
 * `docs/api-list-contract.md` rule 2: every sortable field needs an index
 * ending in the tiebreak, `(organization_id, <sort column>, id)`, or the keyset
 * seek `paginate()` builds degrades to a scan and cursor pagination loses the
 * property it exists for.
 *
 * 1. **`idx_payment_intents_tool_calls_feed`.** `GET /api/v1/tool-calls`
 *    defaults to `createdAt`. `payment_intents` already carries
 *    `idx_payment_intents_organization_id` and `idx_payment_intents_agent`,
 *    neither of which ends in `id` — a plain `(organization_id)` index cannot
 *    serve an ordered keyset seek at all, and `(organization_id, agent_id)` is
 *    the wrong leading columns for a list that is not agent-scoped.
 * 2. **`idx_payment_intents_tool_calls_price_feed`.** The same endpoint sorts
 *    on `priceAmount` too — `docs/api-list-contract.md`'s rule is per sortable
 *    field, not just the default one.
 * 3. **`idx_agent_credentials_feed`.** `GET /api/v1/agents/:agentId/credentials`
 *    sorts on `createdAt` within one agent.
 *    `idx_agent_credentials_agent` (`1756000000000-create-api-surface-tables`)
 *    already covers `(organization_id, agent_id, created_at)` but stops one
 *    column short of the tiebreak, so two credentials created in the same
 *    instant — which `POST .../credentials` followed immediately by a retry
 *    can produce — are not resolvable by the keyset predicate on that index
 *    alone.
 *
 * `notifications` and `audit_log_entries` already carry
 * `idx_notifications_feed` / `idx_audit_log_entries_feed` in the shape this
 * contract wants, so neither needs anything here.
 */
export class ToolCallsAndAccountIndexes1756200000000 implements MigrationInterface {
  name = 'ToolCallsAndAccountIndexes1756200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_tool_calls_feed" ON "payment_intents" ` +
        `("organization_id", "created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_tool_calls_price_feed" ON "payment_intents" ` +
        `("organization_id", "price_amount", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_agent_credentials_feed" ON "agent_credentials" ` +
        `("organization_id", "agent_id", "created_at", "id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_agent_credentials_feed"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_tool_calls_price_feed"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_tool_calls_feed"`);
  }
}
