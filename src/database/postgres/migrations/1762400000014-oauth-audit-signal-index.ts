import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A partial index for the operator dashboard's two audit-derived OAuth signals
 * (spec §6.7): refresh grace uses and stale refresh reuse in the trailing
 * 24 h. `audit_log_entries` is append-only and the platform's largest table;
 * every other index on it leads with `organization_id`, so without this the
 * cross-tenant window would be a sequential scan on each dashboard refresh.
 */
export class OAuthAuditSignalIndex1762400000014 implements MigrationInterface {
  name = 'OAuthAuditSignalIndex1762400000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_audit_log_entries_oauth_signals" ON "audit_log_entries" ("created_at") ` +
        `WHERE "action" IN ('oauth.refresh_grace_used', 'oauth.refresh_stale_reuse')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_audit_log_entries_oauth_signals"`);
  }
}
