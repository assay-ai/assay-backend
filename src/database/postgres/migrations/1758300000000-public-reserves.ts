import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The two things the proof-of-reserves page needs that nothing currently keeps.
 *
 * ## `reconciliation_runs.vault_slot`
 *
 * `SquadsVaultService.getVaultBalance` destructures only `const { value }` off
 * `getTokenAccountBalance(...).send()`, so the RPC's `context.slot` — the slot
 * the balance was true at — is thrown away. Frame `HoO9X` prints it twice, and
 * a page that says "observed on-chain" without saying *when* is asserting less
 * than it appears to: a reader cannot check a balance against the chain without
 * knowing which slot to check it at.
 *
 * **Nullable, and deliberately not backfilled.** Every row written before this
 * migration was read at a slot nobody recorded. The page renders those as `—`.
 * Inventing a slot for them would be the one thing this page exists not to do.
 *
 * ## `stake_snapshots`
 *
 * Total bonded stake is a **platform-wide** figure denominated in
 * `Config.stake_mint`, and computing it is `ceil(N/100)` RPC reads
 * (`SolanaSettlementStakeReader.bondedStakeOf` batches by
 * `MAX_ACCOUNTS_PER_RPC_BATCH`). So it cannot be produced inside a page
 * request, and it does not belong on a `reconciliation_runs` row — those are
 * **per asset**, written once per asset per tick, while this number is per
 * platform.
 *
 * Three further reasons it is a separate table rather than a column, all of
 * which were arguments against the first draft of this design:
 *
 * 1. **Ownership.** `reconciliation_runs` is written by `ReconciliationJob`;
 *    the fleet stake read lives in `StakeMonitorService` — a different module
 *    on a different cron. One of them would have had to write a row it does
 *    not own.
 * 2. **Failure isolation.** An exception inside `ReconciliationService.run()`
 *    becomes a `RECONCILIATION_BLIND` finding at `CRITICAL`. Folding a stake
 *    RPC into that path would let a stake outage blind the *reserves* check —
 *    two unrelated things sharing one fate.
 * 3. **Honesty.** A separate table forces the page to say "stake read at X"
 *    next to "reconciled at Y", because they genuinely are two readings taken
 *    at two times. A column would have implied they were one.
 *
 * **No `organizationId`, deliberately.** This is the whole platform's number,
 * for the same reason `ReconciliationRunEntity` carries none — see that
 * entity's own class comment. It is not tenant data and must never be scoped.
 */
export class PublicReserves1758300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reconciliation_runs" ADD COLUMN "vault_slot" bigint NULL`,
    );

    // `numeric(78,0)` matches every other atomic-money column in this schema
    // (`vault_balance`, `total_liabilities`, `difference`): minor units, held
    // as an exact integer, never a float.
    await queryRunner.query(`
      CREATE TABLE "stake_snapshots" (
        "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        "updated_at"     timestamptz NOT NULL DEFAULT now(),
        "version"        integer NOT NULL DEFAULT 1,
        "read_at"        timestamptz NOT NULL,
        "stake_asset"    varchar(256) NOT NULL,
        "decimals"       integer NOT NULL,
        "bonded_total"   numeric(78,0) NOT NULL,
        "provider_count" integer NOT NULL
      )
    `);

    // The only read this table has is "the newest one", so the index is the
    // whole access pattern.
    await queryRunner.query(
      `CREATE INDEX "idx_stake_snapshots_read_at" ON "stake_snapshots" ("read_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "stake_snapshots"`);
    await queryRunner.query(`ALTER TABLE "reconciliation_runs" DROP COLUMN IF EXISTS "vault_slot"`);
  }
}
