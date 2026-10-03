import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The `slash_proposals` mirror of the on-chain `SlashRecord`.
 *
 * Two-phase slashing split the program's one-shot `slash` into `propose_slash`
 * → 72h → `execute_slash`. The row is still the system of record for the
 * *case*; these columns are the row's copy of what the *chain* thinks, and
 * every one of them is written from a decoded account rather than from this
 * process's clock.
 *
 * Two of them carry the whole design:
 *
 * - `chain_executable_at` is the chain's own deadline. `earliest_execution_at`
 *   stays the promise the provider was told and is never moved; the executor
 *   waits on the later of the two, so a chain configured with a longer
 *   `slash_delay_seconds` cannot be executed early by us.
 * - `chain_epoch` is why the replay lock survives a recalculation. The chain's
 *   `request_id` is `sha256('x402:slash-request:v1' || id || ':' || epoch)`, and
 *   `UPHELD_RECALCULATED` lowers a penalty that is already frozen on chain —
 *   the only correct sequence is cancel, bump, re-propose. Epoch 0 reproduces
 *   the pre-existing derivation byte for byte, so no live row's id moves.
 *
 * ## Two existing CHECKs are relaxed, and neither is dropped
 *
 * Both were exactly right for a one-shot `slash` and both refuse a row the
 * two-phase lifecycle legitimately writes. Neither is loosened past the case
 * that needs it — see the comments at each.
 */
export class SlashProposalsTwoPhaseChain1759000000000 implements MigrationInterface {
  name = 'SlashProposalsTwoPhaseChain1759000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `chain_last_error` is NOT only a diagnostic string, and a reader who
    // treats it as one will delete a loop guard.
    //
    // `SlashExecutionService.executeDue` branches on the single value
    // `'ExecutedBeyondDecision'` (`EXECUTED_BEYOND_DECISION`, defined at
    // `src/modules/slash/services/slash-execution.service.ts:141`, written at
    // :1396, read at :764) and `continue`s past the row. That skip is the only
    // thing keeping a case whose on-chain execution the row cannot legally
    // record — `applied_amount > penalty_amount`, which
    // `chk_slash_proposals_applied_within_penalty` refuses — out of the
    // executable sweep for ever. Clearing, truncating or repurposing this
    // column removes it. Preserve that exact string in any cleanup.
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD COLUMN "chain_status"             varchar(16)   NOT NULL DEFAULT 'NONE',
        ADD COLUMN "chain_epoch"              integer       NOT NULL DEFAULT 0,
        ADD COLUMN "chain_proposed_at"        timestamptz,
        ADD COLUMN "chain_executable_at"      timestamptz,
        ADD COLUMN "chain_reserved"           numeric(78,0),
        ADD COLUMN "chain_proposal_signature" varchar(128),
        ADD COLUMN "chain_claimed_at"         timestamptz,
        ADD COLUMN "chain_last_error"         varchar(64)
    `);

    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD CONSTRAINT "chk_slash_proposals_chain_status" CHECK ("chain_status" IN (
          'NONE', 'PROPOSING', 'PENDING', 'EXECUTED', 'CANCELLED', 'REFUSED'
        ))
    `);

    // A PENDING mirror without the chain's own clocks is a row that would be
    // executed on this process's guess. Both come off the account or neither.
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD CONSTRAINT "chk_slash_proposals_chain_pending_is_whole" CHECK (
          "chain_status" NOT IN ('PENDING', 'EXECUTED')
          OR ("chain_proposed_at" IS NOT NULL AND "chain_executable_at" IS NOT NULL)
        )
    `);

    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD CONSTRAINT "chk_slash_proposals_chain_epoch_non_negative" CHECK ("chain_epoch" >= 0)
    `);

    // The one rule the guard band exists to make true, written down where a
    // service that forgets cannot break it: nothing executes before the chain
    // says it may.
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD CONSTRAINT "chk_slash_proposals_execution_respects_chain_timelock" CHECK (
          "executed_at" IS NULL
          OR "chain_executable_at" IS NULL
          OR "executed_at" >= "chain_executable_at"
        )
    `);

    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        DROP CONSTRAINT "chk_slash_proposals_resolution_kind"
    `);
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD CONSTRAINT "chk_slash_proposals_resolution_kind" CHECK (
          "resolution_kind" IS NULL OR "resolution_kind" IN (
            'ADJUDICATOR', 'AUTO_UNDISPUTED', 'AUTO_PLATFORM_MISS', 'AUTO_DE_MINIMIS',
            'AUTO_CHAIN_VOIDED'
          )
        )
    `);

    // `AUTO_CHAIN_VOIDED` closes a case at any point in its life, and the main
    // one it closes is a case an adjudicator already decided: the executable
    // sweep selects `status = 'UPHELD'`, and an UPHELD row that reached that
    // status through `decide()` carries `outcome = 'UPHELD'` or
    // `'UPHELD_RECALCULATED'` and `resolution_kind = 'ADJUDICATOR'`. Overwriting
    // the kind while leaving the outcome is deliberate — the human's judgement
    // is still what it was, and only the *closure* was automatic — but it makes
    // the old biconditional false for exactly that row.
    //
    // So the biconditional is kept for every other kind and one more pair is
    // admitted beside it. It is not widened to "any outcome": an overturn never
    // reaches this path (`OVERTURNED` is terminal and is not one of the six
    // statuses `voidCase` transitions from), and admitting one would let a
    // chain refusal record a decision that cancels a penalty nobody made.
    //
    // Every comparison is `IS [NOT] DISTINCT FROM` rather than `=`, which the
    // original was not. A CHECK passes when it evaluates to NULL, so the old
    // biconditional silently ADMITTED `(outcome NOT NULL, resolution_kind NULL)`
    // — a judgement with nobody and nothing attached to it — because
    // `NULL = 'ADJUDICATOR'` is NULL rather than false. No code path writes that
    // tuple today; the null-safe operators make sure none ever can.
    //
    // Tuples `(status, outcome, resolution_kind)` written by the chain
    // lifecycle, and the complete set this constraint has to admit beyond what
    // it already did:
    //
    //   (CANCELLED, NULL,                 'AUTO_CHAIN_VOIDED')  -- already legal
    //   (CANCELLED, 'UPHELD',             'AUTO_CHAIN_VOIDED')  -- new
    //   (CANCELLED, 'UPHELD_RECALCULATED','AUTO_CHAIN_VOIDED')  -- new
    //   (EXECUTED,  <unchanged>,          <unchanged>)          -- already legal
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        DROP CONSTRAINT "chk_slash_proposals_outcome_needs_adjudicator"
    `);
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD CONSTRAINT "chk_slash_proposals_outcome_needs_adjudicator" CHECK (
          ("outcome" IS NULL AND "resolution_kind" IS DISTINCT FROM 'ADJUDICATOR')
          OR ("outcome" IS NOT NULL AND "resolution_kind" IS NOT DISTINCT FROM 'ADJUDICATOR')
          OR (
            "outcome" IN ('UPHELD', 'UPHELD_RECALCULATED')
            AND "resolution_kind" IS NOT DISTINCT FROM 'AUTO_CHAIN_VOIDED'
          )
        )
    `);

    // A signature still requires an `executed_at`; an `executed_at` no longer
    // requires a signature.
    //
    // `reconcileExecuting` reads a record the chain says is `Executed` on a row
    // whose submitting process died between send and confirm. It has the
    // amounts, the `executed_at` and no signature, and the honest thing to
    // record is exactly that — fabricating one would put a transaction in the
    // provider's case timeline that nobody can look up. The other half of the
    // old rule stands untouched: an execution without an `applied_amount` is
    // still a row that cannot say what was taken.
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        DROP CONSTRAINT "chk_slash_proposals_executed_is_whole"
    `);
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD CONSTRAINT "chk_slash_proposals_executed_is_whole" CHECK (
          ("execution_signature" IS NULL OR "executed_at" IS NOT NULL)
          AND ("executed_at" IS NULL OR "applied_amount" IS NOT NULL)
        )
    `);

    // The drain. Under the old code EXECUTING meant "a one-shot slash may be in
    // flight"; under the new code it means "an execute_slash may be in flight",
    // and the reconciler would go looking for an on-chain record that no
    // pre-two-phase row ever had. UPHELD is already a legal predecessor of
    // EXECUTING, so the case simply re-enters the execution queue — where it
    // will now be proposed first.
    await queryRunner.query(`
      UPDATE "slash_proposals" SET "status" = 'UPHELD' WHERE "status" = 'EXECUTING'
    `);

    // The propose sweep's predicate. Partial, because the rows it wants are a
    // small and shrinking minority of the table.
    await queryRunner.query(`
      CREATE INDEX "idx_slash_proposals_awaiting_chain_proposal"
        ON "slash_proposals" ("respond_by_at")
        WHERE "chain_status" IN ('NONE', 'PROPOSING')
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_slash_proposals_chain_executable_at"
        ON "slash_proposals" ("chain_executable_at")
        WHERE "chain_status" = 'PENDING'
    `);

    // The reconciler's predicate — `status = 'EXECUTING' AND chain_claimed_at`
    // older than the stale window. `EXECUTING` is meant to be a state a row
    // occupies for seconds, so the partial index is nearly empty in the healthy
    // case and is exactly the rows a crash leaves behind.
    await queryRunner.query(`
      CREATE INDEX "idx_slash_proposals_executing_claimed_at"
        ON "slash_proposals" ("chain_claimed_at")
        WHERE "status" = 'EXECUTING'
    `);

    // The reconciler's *other* predicate: the adopted-EXECUTED park, where the
    // chain mirror says the money moved and the row has no execution on it.
    // `findExecutingToReconcile` ORs the two shapes, so each needs its own
    // partial index for the planner to reach them without a sequential scan
    // once a minute. Both are nearly empty in a healthy deployment — this one
    // requires a record executed at a request id whose row never left
    // `NONE`/`PROPOSING`.
    await queryRunner.query(`
      CREATE INDEX "idx_slash_proposals_chain_executed_unrecorded"
        ON "slash_proposals" ("chain_claimed_at")
        WHERE "chain_status" = 'EXECUTED' AND "executed_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_slash_proposals_chain_executed_unrecorded"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_slash_proposals_executing_claimed_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_slash_proposals_chain_executable_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_slash_proposals_awaiting_chain_proposal"`);

    // The drain is not reversed: an EXECUTING row's original status is not
    // recoverable from the row, and UPHELD is the safe state either way.

    // Both relaxations are reversed to their exact pre-two-phase text. Any row
    // the chain lifecycle wrote that the original refuses has to be resolved by
    // hand first — which is the point of restoring them rather than leaving the
    // looser rule behind after a rollback.
    await queryRunner.query(`
      ALTER TABLE "slash_proposals" DROP CONSTRAINT "chk_slash_proposals_executed_is_whole"
    `);
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD CONSTRAINT "chk_slash_proposals_executed_is_whole" CHECK (
          ("executed_at" IS NULL) = ("execution_signature" IS NULL)
          AND ("executed_at" IS NULL OR "applied_amount" IS NOT NULL)
        )
    `);

    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        DROP CONSTRAINT "chk_slash_proposals_outcome_needs_adjudicator"
    `);
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD CONSTRAINT "chk_slash_proposals_outcome_needs_adjudicator" CHECK (
          ("resolution_kind" = 'ADJUDICATOR') = ("outcome" IS NOT NULL)
        )
    `);

    await queryRunner.query(`
      ALTER TABLE "slash_proposals" DROP CONSTRAINT "chk_slash_proposals_resolution_kind"
    `);
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD CONSTRAINT "chk_slash_proposals_resolution_kind" CHECK (
          "resolution_kind" IS NULL OR "resolution_kind" IN (
            'ADJUDICATOR', 'AUTO_UNDISPUTED', 'AUTO_PLATFORM_MISS', 'AUTO_DE_MINIMIS'
          )
        )
    `);

    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        DROP CONSTRAINT "chk_slash_proposals_execution_respects_chain_timelock",
        DROP CONSTRAINT "chk_slash_proposals_chain_epoch_non_negative",
        DROP CONSTRAINT "chk_slash_proposals_chain_pending_is_whole",
        DROP CONSTRAINT "chk_slash_proposals_chain_status",
        DROP COLUMN "chain_last_error",
        DROP COLUMN "chain_claimed_at",
        DROP COLUMN "chain_proposal_signature",
        DROP COLUMN "chain_reserved",
        DROP COLUMN "chain_executable_at",
        DROP COLUMN "chain_proposed_at",
        DROP COLUMN "chain_epoch",
        DROP COLUMN "chain_status"
    `);
  }
}
