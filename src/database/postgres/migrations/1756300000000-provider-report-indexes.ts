import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes the provider report surface needs and the schema did not have
 * (`src/modules/provider/**`).
 *
 * Every provider-side report (`traffic`, `quality`, `earnings`, `sla-windows`)
 * queries `payment_intents` / `verification_records` **by `provider_id`**
 * rather than by `organization_id` — a provider's calls are served to every
 * buying organization, not its own, so the existing `organization_id`-leading
 * indexes on both tables (`idx_payment_intents_agent`,
 * `idx_verification_records_tool`) do not help a provider-scoped scan. See
 * `ProviderTrafficService` for the full explanation of why these queries are
 * deliberately cross-organization.
 *
 * `idx_ledger_entries_org_type_created` is the one index here for an
 * ordinary, same-tenant cursor list (`GET /providers/me/payouts`, via
 * `paginate()`): `docs/api-list-contract.md` rule 2 requires the sort column's
 * index to end in the tiebreak, i.e. `(organization_id, created_at, id)`, with
 * `entry_type` as a leading filter column ahead of the sort key.
 */
export class ProviderReportIndexes1756300000000 implements MigrationInterface {
  name = 'ProviderReportIndexes1756300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_payment_intents_provider_created" ON "payment_intents" ` +
        `("provider_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_verification_records_provider_created" ON "verification_records" ` +
        `("provider_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ledger_entries_org_type_created" ON "ledger_entries" ` +
        `("organization_id", "entry_type", "created_at", "id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_ledger_entries_org_type_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_verification_records_provider_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_provider_created"`);
  }
}
