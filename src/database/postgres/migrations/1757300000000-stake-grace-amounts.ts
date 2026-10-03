import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What `provider_stake_grace` was still missing.
 *
 * `1757100000000-create-provider-stake-grace` built the table and the partial
 * unique index that keeps the clock from restarting. Three gaps survived its
 * review, and all three are cheapest to close now, while the table is empty:
 * nothing writes to it yet — `applyStakeGrace` only reads a date the router
 * hands it, and the monitor job that inserts rows does not exist yet.
 *
 * ```text
 * asset_id     the two amounts finally say what they are denominated in
 * 4 × CHECK    a grace period cannot open on a shortfall that is not one
 * resolution   how the period ENDED, recorded rather than inferred
 * ```
 *
 * ## 1. Two money columns with no asset were not money
 *
 * `required_amount` and `observed_amount` are `numeric(78,0)` minor units, and
 * a bare minor-unit count is meaningless: `"10000"` is one cent of USDC or a
 * rounding error of BONK. Every other money-bearing table in this schema
 * already carries the denomination beside the amount — `payment_intents`,
 * `ledger_entries`, `account_balances`, `tool_bindings`, `provider_payouts` —
 * and `Money` itself refuses to exist without it.
 *
 * It is not a formality here in particular. The gate whose verdict opens these
 * rows treats an amount-without-an-asset as unsafe enough to have **two**
 * separate `STAKE_ASSET_MISMATCH` rejection paths — one for the binding's
 * price, one for the stake reading — precisely so that a comparison across
 * denominations can never happen silently. Storing the result of that
 * comparison without the asset would throw away the fact both paths exist to
 * establish. And the stake screen has to render *"the exact amount needed"*
 * against the countdown, which is `MoneyUtil.format` and needs the asset.
 *
 * `NOT NULL` with no backfill and no default: the table has no writer, so it is
 * empty in every environment by construction. If it is not, this migration
 * fails loudly on the environment concerned — which is the right outcome, since
 * a row already there would be one whose denomination genuinely is unknown and
 * cannot be guessed.
 *
 * The same fact makes `down()` one-way the moment rows exist: reverting drops
 * `asset_id`, and re-applying then fails with *"column asset_id contains null
 * values"* because there is no default to fill the rows the revert stripped.
 * Harmless while the table has no writer — but the stake monitor is the writer,
 * so the rollback window closes when it ships, and after that a revert of this
 * migration is a one-way decision rather than a step that can be taken back.
 *
 * ## 2. The four things the table was willing to hold
 *
 * As created it accepted `required_amount = -5`, an `observed_amount` *above*
 * the requirement (a grace period opened on no shortfall at all), an
 * `expires_at` before `started_at`, and a `resolved_at` 99 days before the
 * period began. `tool_bindings` next door carries nine CHECKs; this table
 * carried none.
 *
 * The argument is the one migration 0.3 made for its own index, applied a
 * second time. *"We only ever open one"* had to be a constraint rather than a
 * promise made by code nobody had written yet — and *"we only ever open one on
 * a real shortfall"* is the same sentence about the same unwritten code. A
 * grace period is the record of why an under-collateralised binding kept taking
 * paid traffic; a row claiming a shortfall that never existed is a defence of a
 * decision that was never justified, and it would read exactly like a real one
 * in a dispute.
 *
 * `observed_amount < required_amount` is strict, matching the gate: it passes
 * on `stake >= minimum`, so equality is *above* the floor and opens nothing.
 *
 * `resolved_at >= started_at` and not `> `: a period opened and cured inside the
 * same tick is unusual, not impossible, and a constraint that rejected it would
 * make the monitor job crash on the provider who topped up fastest.
 *
 * ## 3. `resolution` — because the timestamps cannot be asked
 *
 * The 0.3 entity claimed the outcome was recoverable: *"a period resolved at or
 * after `expires_at` ran out, and one resolved before it was cured."* That
 * inference breaks at the boundary, in both directions, and the boundary is
 * where every interesting case sits:
 *
 * - A provider tops up 30 seconds before their deadline. The job that notices
 *   runs on a 5-minute tick and writes `resolved_at` *after* `expires_at`. A
 *   **cure** recorded as an **expiry** — a provider marked as having been cut
 *   off when they in fact paid in time.
 * - A sweeper runs late — a deploy, a backlog, a paused scheduler — and closes
 *   an expired period hours after the deadline. Indistinguishable from the case
 *   above, so the ambiguity is not even detectable after the fact.
 *
 * Both readings are wrong by the width of a cron interval, and the direction of
 * the error is not fixed, so it cannot be corrected for either. The stake
 * screen renders this history, and disputes turn on it. The writer knows which
 * of the two happened at the instant it resolves the row; nothing else ever
 * will again. So it is written down.
 *
 * Two values, `CURED` and `EXPIRED`, enforced by CHECK. And a biconditional
 * with `resolved_at`, in the shape `chk_disputes_resolution_is_whole` and
 * `chk_tool_bindings_pause_attributed` already use: an open period can never
 * carry an outcome, and a closed one can never lack it. Half a resolution is
 * the state this migration exists to make unrepresentable.
 *
 * ## Still not in this migration
 *
 * No writer, no reader, no endpoint. Wiring `applyStakeGrace` into the router
 * and opening and resolving these rows come later; until then the table stays
 * empty and the stake gate behaves exactly as it does today.
 */
export class StakeGraceAmounts1757300000000 implements MigrationInterface {
  name = 'StakeGraceAmounts1757300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `NOT NULL` outright. No writer exists, so there is nothing to backfill —
    // and inventing a default asset for a hypothetical row would be asserting
    // the one fact the column was added because we did not have.
    await queryRunner.query(`
      ALTER TABLE "provider_stake_grace"
        ADD COLUMN "asset_id"   varchar(256) NOT NULL,
        ADD COLUMN "resolution" varchar(16)
    `);

    await queryRunner.query(`
      ALTER TABLE "provider_stake_grace"
        ADD CONSTRAINT "chk_provider_stake_grace_amounts_non_negative"
          CHECK ("required_amount" >= 0 AND "observed_amount" >= 0),

        -- A grace period is the record of a shortfall. Without one there is
        -- nothing to be graceful about, and the row would defend routing that
        -- needed no defence.
        ADD CONSTRAINT "chk_provider_stake_grace_is_a_shortfall"
          CHECK ("observed_amount" < "required_amount"),

        -- The countdown FP-41 renders has to count down.
        ADD CONSTRAINT "chk_provider_stake_grace_expires_after_start"
          CHECK ("expires_at" > "started_at"),

        -- A period cannot close before it opened. Inclusive on purpose: opened
        -- and cured within the same tick is unusual, not impossible.
        ADD CONSTRAINT "chk_provider_stake_grace_resolved_after_start"
          CHECK ("resolved_at" IS NULL OR "resolved_at" >= "started_at"),

        ADD CONSTRAINT "chk_provider_stake_grace_resolution"
          CHECK ("resolution" IS NULL OR "resolution" IN ('CURED', 'EXPIRED')),

        -- Whole, or absent. An open period with an outcome and a closed one
        -- without are both states no writer should be able to produce.
        ADD CONSTRAINT "chk_provider_stake_grace_resolution_attributed"
          CHECK (("resolved_at" IS NULL) = ("resolution" IS NULL))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "provider_stake_grace"
        DROP CONSTRAINT IF EXISTS "chk_provider_stake_grace_resolution_attributed",
        DROP CONSTRAINT IF EXISTS "chk_provider_stake_grace_resolution",
        DROP CONSTRAINT IF EXISTS "chk_provider_stake_grace_resolved_after_start",
        DROP CONSTRAINT IF EXISTS "chk_provider_stake_grace_expires_after_start",
        DROP CONSTRAINT IF EXISTS "chk_provider_stake_grace_is_a_shortfall",
        DROP CONSTRAINT IF EXISTS "chk_provider_stake_grace_amounts_non_negative"
    `);

    await queryRunner.query(`
      ALTER TABLE "provider_stake_grace"
        DROP COLUMN IF EXISTS "resolution",
        DROP COLUMN IF EXISTS "asset_id"
    `);
  }
}
