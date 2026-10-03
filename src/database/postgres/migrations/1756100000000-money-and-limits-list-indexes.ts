import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Money and limits" — the keyset indexes the buyer-side list
 * endpoints need and the schema did not have.
 *
 * `api-list-contract.md` rule 2: "the sort column needs an index ending in the
 * tiebreak, i.e. `(organization_id, <sort column>, id)`". None of the three
 * tables below had one for `created_at`:
 *
 * - `ledger_holds` had `(organization_id, account_id, status)` and
 *   `(status, expires_at)` — neither leads with `created_at`, so `GET /holds`
 *   (sorted newest-first, `status = 'OPEN'` filtered in the application) would
 *   have scanned.
 * - `deposit_intents` had `(organization_id)`, `(organization_id, agent_id)`,
 *   `(status, expires_at)` — same gap for `GET /deposits`.
 * - `spend_policies` had `idx_spend_policies_current` on
 *   `(organization_id, agent_id, created_at)`, three columns short only the
 *   `id` tiebreak. Added here as a superset rather than editing the original
 *   migration (`1756000000000-create-api-surface-tables`), which other work
 *   in this milestone depends on unchanged.
 */
export class MoneyAndLimitsListIndexes1756100000000 implements MigrationInterface {
  name = 'MoneyAndLimitsListIndexes1756100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_ledger_holds_org_created" ON "ledger_holds" ` +
        `("organization_id", "created_at", "id")`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_deposit_intents_org_created" ON "deposit_intents" ` +
        `("organization_id", "created_at", "id")`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_spend_policies_history" ON "spend_policies" ` +
        `("organization_id", "agent_id", "created_at", "id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_spend_policies_history"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_deposit_intents_org_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_ledger_holds_org_created"`);
  }
}
