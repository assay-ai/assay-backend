import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One resolution per on-chain signature, enforced by the database.
 *
 * ## What this replaces
 *
 * `DepositFinalityService.promotePendingDeposits` guards against a second
 * credit by reading the journal and skipping a deposit that already has a
 * `DEPOSIT_CONFIRM` or `DEPOSIT_REJECT`. That is a read-then-write check, and
 * its own comment said what it was resting on:
 *
 * > *"nothing in the database would stop it if this check went away
 * > (`uq_ledger_entries_intent_credit_type` is partial on `PROVIDER_CREDIT` /
 * > `PLATFORM_FEE` and does not cover deposits)"*
 *
 * With one writer — a single-instance scheduler running one cron — the window
 * between the read and the write was never entered. Adding the Helius account
 * watcher puts a **second trigger on the same rows**, so two sweeps can read
 * "not yet resolved" for the same deposit and both write the credit. The buyer
 * is paid twice for one transfer, and the ledger's append-only trigger means
 * the extra row cannot be deleted afterwards — only compensated.
 *
 * A read can never close a read-then-write race. The invariant moves here.
 *
 * ## Why the key is the signature
 *
 * `chain_tx_ref` is a Solana transaction signature: globally unique, and the
 * one identifier both writers already have in hand. Keying on
 * `(organization_id, intent_id)` would enforce the narrower claim "this intent
 * resolves once"; keying on the signature enforces "this *transfer* is credited
 * once", which is the claim that protects the money.
 *
 * ## Why the predicate is not optional
 *
 * `DepositService.settleDeposit` writes `DEPOSIT_PENDING` with the **same**
 * `chain_tx_ref` the resolution will carry. An index over the bare column would
 * therefore refuse the confirm on account of the pending row that must precede
 * it. Restricting it to the two resolving types is what makes the constraint
 * express the intended rule instead of an accidental one.
 *
 * `DEPOSIT` (the older single-entry form, still present on seeded rows)
 * carries no `chain_tx_ref` and is excluded by the `IS NOT NULL` arm, along
 * with any future entry that resolves without naming a transaction.
 *
 * Verified before writing this: `SELECT chain_tx_ref, count(*) ... GROUP BY
 * chain_tx_ref HAVING count(*) > 1` returns zero rows, so the index builds
 * without a repair step. `CREATE UNIQUE INDEX` (not `CONCURRENTLY`) because
 * TypeORM runs migrations inside a transaction, which `CONCURRENTLY` forbids —
 * the table is small enough that the write lock is measured in milliseconds.
 */
export class DepositResolutionUniqueness1758200000000 implements MigrationInterface {
  name = 'DepositResolutionUniqueness1758200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_ledger_entries_deposit_resolution"
        ON "ledger_entries" ("chain_tx_ref")
        WHERE "entry_type" IN ('DEPOSIT_CONFIRM', 'DEPOSIT_REJECT')
          AND "chain_tx_ref" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_ledger_entries_deposit_resolution"`);
  }
}
