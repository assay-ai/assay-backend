import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The verdict feed's keyset index.
 *
 * `GET /api/v1/verdicts` sorts on `created_at` with `organization_id` as the
 * tenant predicate, per `docs/api-list-contract.md` rule 2: "the sort column
 * needs an index ending in the tiebreak, i.e.
 * `(organization_id, <sort column>, id)`". Nothing on `verification_records`
 * had that shape — `idx_verification_records_tool` covers
 * `(organization_id, tool_id, created_at)`, useful only when the request
 * filters by `toolId`, and `idx_verification_records_state`/`_unsettled` are
 * not organization-scoped at all (they serve the worker's own sweeps, a
 * platform-level concern). A list request with no `toolId` filter — the common
 * case — had no index to seek on and would have scanned.
 *
 * `idx_verification_records_decision_policy` serves the `policyId` filter
 * (`ListVerdictsQueryDto`, which filters on `decisionPolicyId` — see that
 * file for why): "every verdict this policy decided" is the operational query
 * behind an incident, and it deserves the same treatment rather than falling
 * back to the organization-only index and a filter scan.
 *
 * `disputes` needs nothing here: `1756000000000-create-api-surface-tables`
 * already added `idx_disputes_feed` on `(organization_id, created_at, id)`.
 */
export class VerdictsListIndexes1756400000000 implements MigrationInterface {
  name = 'VerdictsListIndexes1756400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_verification_records_org_feed" ON "verification_records" ` +
        `("organization_id", "created_at", "id")`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_verification_records_decision_policy" ON "verification_records" ` +
        `("organization_id", "decision_policy_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_verification_records_decision_policy"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_verification_records_org_feed"`);
  }
}
