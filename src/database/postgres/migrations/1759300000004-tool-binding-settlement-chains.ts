import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Which chains a binding is offered on.
 *
 * ## Why this is on the binding and not on the provider
 *
 * *"One tool binding may serve both chains. Serving both is normal ... the
 * endpoint is one HTTPS service; only the settlement is chain-bound."* A
 * provider enrolled on two chains may still wish to offer one particular tool
 * on one of them, and the enrolment cannot express that. So the enrolment says
 * *where this provider can be paid* and this column says *where this tool is
 * offered* — two different facts, and collapsing them would make disabling one
 * tool on one chain mean un-enrolling from the chain entirely.
 *
 * ## And why it is not evidence of anything
 *
 * This is configuration. It records an intention, not a fact about a chain.
 * `A.2-REFINED` is explicit: *"the binding's chain list is platform config, the
 * stake is on chain, so nothing enforces this by construction. It has to be a
 * check, and it has to be re-evaluated rather than cached at registration
 * time."* The write-time gate is `BindingEditorService`; the re-check is
 * `gatherCandidates`. Neither is optional and the second is the load-bearing
 * one.
 *
 * ## The backfill comes from asset_id
 *
 * `asset_id` is NOT NULL on every row and is CAIP-19, so its chain is by
 * construction the chain that binding already settles on. Deriving from the
 * provider's enrolment instead would yield an empty array — forbidden by the
 * CHECK — for any binding whose provider never proved a payout address, and
 * those bindings exist.
 *
 * ## varchar(64)[] with an array_to_string CHECK
 *
 * Measured on PostgreSQL 15.18 before being written: `array_to_string` is
 * usable inside a CHECK, and the grammar rejects a non-CAIP-2 element. There is
 * deliberately no DEFAULT: a row that does not name its chains must not be
 * insertable, and `DEFAULT '{}'` would make one insertable by omission.
 *
 * **`array_length(...) >= 1` is belt-and-braces and cannot refuse anything on
 * its own** — measured here, against the claim it was written under. For the
 * empty array `array_length(chains, 1)` is `NULL`, `NULL >= 1` is `NULL`, and a
 * CHECK *passes* on NULL, so that conjunct alone accepts `'{}'` as readily as
 * it accepts `ARRAY['mainnet']`. The empty array is refused by the grammar
 * instead: it renders as the empty string, which the pattern does not match.
 * The conjunct stays because it states the intent at the point a reader looks
 * for it, but the grammar is doing all of the work and a change to the pattern
 * has nothing behind it.
 *
 * **The third argument to `array_to_string` is load-bearing.** With two
 * arguments the function *skips* NULL elements, so `ARRAY['solana:EtWT…', NULL]`
 * renders as `solana:EtWT…`, matches the grammar and is ACCEPTED — measured on
 * this database, which stored exactly that row before the third argument was
 * added. A NULL in the list is a chain the router would compare against
 * `null`, and `array_length` cannot see it either (that array has length 2).
 * Rendering NULL as the empty string instead makes the same row read
 * `solana:EtWT…,` — a trailing separator with no chain after it, which the
 * grammar rejects. One character of SQL, and the check becomes total over the
 * array rather than over its non-NULL part.
 */
export class ToolBindingSettlementChains1759300000004 implements MigrationInterface {
  name = 'ToolBindingSettlementChains1759300000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tool_bindings" ADD COLUMN "settlement_chains" varchar(64)[]
    `);

    await queryRunner.query(`
      UPDATE "tool_bindings"
      SET "settlement_chains" = ARRAY[
        split_part("asset_id", ':', 1) || ':' || split_part(split_part("asset_id", ':', 2), '/', 1)
      ]
    `);

    const [{ unset }] = (await queryRunner.query(`
      SELECT count(*)::int AS unset FROM "tool_bindings"
      WHERE "settlement_chains" IS NULL
         OR array_length("settlement_chains", 1) IS NULL
         OR NOT (array_to_string("settlement_chains", ',', '')
                 ~ '^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$')
    `)) as { unset: number }[];

    if (unset > 0) {
      throw new Error(
        `${unset} tool_binding(s) did not derive a settlement chain from asset_id. ` +
          `Inspect those rows: an asset_id that is not CAIP-19 is the likely cause. ` +
          `Do not relax the derivation — a binding with no chain is a binding that ` +
          `routes nowhere, and the CHECK below would refuse it anyway.`,
      );
    }

    await queryRunner.query(`
      ALTER TABLE "tool_bindings"
        ALTER COLUMN "settlement_chains" SET NOT NULL,
        ADD CONSTRAINT "chk_tool_bindings_settlement_chains" CHECK (
          array_length("settlement_chains", 1) >= 1
          AND array_to_string("settlement_chains", ',', '')
              ~ '^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}(,[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32})*$'
        )
    `);

    // The router asks "which ACTIVE bindings of this tool name this chain".
    // GIN over the array is what makes the `&&` operator an index scan rather
    // than a sequential one on a table that grows with the catalogue.
    await queryRunner.query(`
      CREATE INDEX "idx_tool_bindings_settlement_chains"
        ON "tool_bindings" USING GIN ("settlement_chains")
    `);

    await queryRunner.query(
      `COMMENT ON COLUMN "tool_bindings"."settlement_chains" IS ` +
        `'CAIP-2. Which chains this binding is OFFERED on — the provider''s declaration, not ` +
        `evidence of stake. Routability on a chain also requires an ACTIVE enrolment there ` +
        `holding stake at or above that chain''s minimum, re-checked on every routing decision.'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tool_bindings_settlement_chains"`);
    await queryRunner.query(
      `ALTER TABLE "tool_bindings" DROP CONSTRAINT IF EXISTS "chk_tool_bindings_settlement_chains"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tool_bindings" DROP COLUMN IF EXISTS "settlement_chains"`,
    );
  }
}
