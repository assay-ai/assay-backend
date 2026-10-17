import { MigrationInterface, QueryRunner } from 'typeorm';

const INDEX = 'idx_payment_intents_idempotency_key';
/** The replacement is built beside the old index under this name, then renamed. */
const STAGED = 'idx_payment_intents_idempotency_key_staged';

const KEY_COLUMNS = `("organization_id", "agent_id", "idempotency_key")`;
const LIVE_PREDICATE = `"idempotency_key" IS NOT NULL AND "status" NOT IN ('VOIDED', 'EXPIRED', 'REFUNDED')`;
const ANY_KEY_PREDICATE = `"idempotency_key" IS NOT NULL`;

/**
 * Narrows `idx_payment_intents_idempotency_key` to the intents that may still
 * charge the agent (G2.1).
 *
 * The index was unique over every row that carried a key, whatever its status.
 * Nothing wrote a key until the MCP `tools/call` path started passing
 * `_meta["x402/idempotency-key"]`, and that caller needs one thing the old
 * index forbids: a call that **failed without a charge** must leave its key
 * free, so the agent's retry runs as a fresh attempt instead of being answered
 * with a dead intent forever.
 *
 * The three statuses left out are exactly the ones in which the agent was not
 * charged:
 *
 * - `VOIDED` — the provider failed or nothing was routable; the hold was
 *   released.
 * - `EXPIRED` — the intent never got moving (no funds secured, or the sweep
 *   released them).
 * - `REFUNDED` — the hold was released after verification failed.
 *
 * Every other status — `CREATED` through `SETTLED` — keeps the key, so two
 * attempts of one logical call can never both hold the agent's money. A row
 * that moves into one of the three releases its key by leaving the index;
 * Postgres maintains a partial index on UPDATE, so no trigger is needed.
 *
 * Existing rows are unaffected in practice: no caller wrote `idempotency_key`
 * before this change. The index stays unique on the same columns and keeps
 * its name, so `PaymentIntentService.create`'s insert-first arbitration works
 * unchanged.
 *
 * ## Built `CONCURRENTLY`, outside a transaction
 *
 * Same reasoning as `1760400000000-public-explorer-index.ts`: a plain
 * `CREATE INDEX` or `DROP INDEX` blocks every write to `payment_intents` —
 * every paid call — for the length of the build. So the new index is built
 * `CONCURRENTLY` under a staging name while the old one keeps guarding, the
 * old one is dropped `CONCURRENTLY`, and the new one takes its name. Between
 * the two steps both indexes exist and both enforce; at no point does none.
 *
 * A concurrent build that failed half way leaves an INVALID staging index
 * behind, which is dropped and rebuilt. A rerun after the rename finds the
 * index already in its target shape and does nothing.
 */
export class IdempotencyKeyLiveIntents1761000000000 implements MigrationInterface {
  name = 'IdempotencyKeyLiveIntents1761000000000';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await swapIndex(queryRunner, LIVE_PREDICATE, (def) => def.includes('VOIDED'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Fails if two rows now share a key (one dead, one live). That is the
    // honest outcome: the wider index cannot be restored over data it forbids,
    // and the old index is still in place when it does.
    await swapIndex(queryRunner, ANY_KEY_PREDICATE, (def) => !def.includes('VOIDED'));
  }
}

/**
 * Replaces {@link INDEX} with a unique index over the same columns and
 * `predicate`, without blocking writes. `done` says whether the current index
 * already has the target shape.
 */
async function swapIndex(
  queryRunner: QueryRunner,
  predicate: string,
  done: (indexdef: string) => boolean,
): Promise<void> {
  const current = await indexdef(queryRunner, INDEX);
  if (current !== null && done(current)) return;

  if ((await indexdef(queryRunner, STAGED)) !== null && !(await isValid(queryRunner, STAGED))) {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${STAGED}"`);
  }
  await queryRunner.query(
    `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${STAGED}" ON "payment_intents" ` +
      `${KEY_COLUMNS} WHERE ${predicate}`,
  );
  await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`);
  await queryRunner.query(`ALTER INDEX "${STAGED}" RENAME TO "${INDEX}"`);
}

async function indexdef(queryRunner: QueryRunner, name: string): Promise<string | null> {
  const rows = (await queryRunner.query(
    `SELECT indexdef FROM pg_indexes WHERE indexname = $1 AND schemaname = current_schema()`,
    [name],
  )) as Array<{ indexdef: string }>;
  return rows[0]?.indexdef ?? null;
}

async function isValid(queryRunner: QueryRunner, name: string): Promise<boolean> {
  const rows = (await queryRunner.query(
    `SELECT i.indisvalid AS valid FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1 AND n.nspname = current_schema()`,
    [name],
  )) as Array<{ valid: boolean }>;
  return rows[0]?.valid === true;
}
