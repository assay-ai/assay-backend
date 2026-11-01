import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A CHANNEL buyer debt settled in the portal with a PER-CALL replacement
 * voucher (client review M-2, coordinator decision 2026-11-01).
 *
 * A channel debt is normally cleared by the agent's client renewing the exact
 * pair it signed on its lane. A client that lost its lane record (a new
 * computer, a deleted state file, an in-memory store) can never renew, and the
 * payer's paid calls stay refused. Once no voucher of the lane that covers the
 * call can still be settled on chain (past its expiry plus the redeem grace),
 * the payer may sign a per-call replacement of the same amount to the same
 * provider, exactly like a per-call debt.
 *
 * The call then MOVES to the per-call door, one way and once:
 * `voucher_format` becomes `PER_CALL`, the channel columns are cleared (so the
 * format CHECK of 1793404800000 holds unchanged) and the former lane position
 * is kept apart in `replaced_channel_*`. Every per-call path (redemption,
 * collect, refund, the held mirror) then takes the row by its format, and no
 * channel path can see it any more: the lane's settle never charges it (a
 * later settle across its cumulative waives that step), a renew finds nothing
 * to renew, and `markReplaced` cannot touch it.
 *
 * Two triggers are widened for exactly that move:
 * - `assert_voucher_format_is_immutable`: CHANNEL → PER_CALL only with the
 *   lane position copied into `replaced_channel_*`; the copy is immutable.
 * - `assert_voucher_seq_is_immutable`: a channel row (no seq) may take its
 *   first seq only as such a replacement of a lapsed debt, once the row's own
 *   voucher and EVERY stored lane voucher covering it are past their on-chain
 *   deadline (`expires_at + 7,320 s` on eip155, as for a per-call debt).
 *
 * Metadata-only DDL under ACCESS EXCLUSIVE with a 5 s `lock_timeout` (retry
 * the deploy on a timeout); the new CHECK is `NOT VALID` (every existing row
 * has the new columns null; new writes are checked).
 */
export class ChannelDebtPerCallReplacement1793404800030 implements MigrationInterface {
  name = 'ChannelDebtPerCallReplacement1793404800030';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await applies(queryRunner))) return;
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        ADD COLUMN IF NOT EXISTS "replaced_channel_row_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "replaced_channel_cumulative" numeric(20, 0) NULL,
        ADD COLUMN IF NOT EXISTS "replaced_channel_calls" integer NULL,
        ADD COLUMN IF NOT EXISTS "channel_replaced_per_call_at" timestamptz NULL`);
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "chk_payment_intents_channel_replacement"`,
    );
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        ADD CONSTRAINT "chk_payment_intents_channel_replacement" CHECK (
          ("replaced_channel_row_id" IS NULL AND "replaced_channel_cumulative" IS NULL
             AND "replaced_channel_calls" IS NULL AND "channel_replaced_per_call_at" IS NULL)
          OR ("voucher_format" = 'PER_CALL' AND "replaced_channel_row_id" IS NOT NULL
             AND "replaced_channel_cumulative" IS NOT NULL AND "replaced_channel_calls" IS NOT NULL
             AND "channel_replaced_per_call_at" IS NOT NULL)) NOT VALID`);
    await queryRunner.query(FORMAT_GUARD_WITH_REPLACEMENT);
    await queryRunner.query(seqGuard(CHANNEL_REPLACEMENT_BRANCH));
  }

  /** Refused while any call was moved: dropping the columns would lose its lane position. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await applies(queryRunner))) return;
    if (await queryRunner.hasColumn('payment_intents', 'replaced_channel_row_id')) {
      const [row] = (await queryRunner.query(
        `SELECT COUNT(*)::int AS "n" FROM "payment_intents" WHERE "replaced_channel_row_id" IS NOT NULL`,
      )) as { n: number }[];
      if (Number(row?.n ?? 0) > 0) {
        throw new Error(
          `ChannelDebtPerCallReplacement1793404800030 down: ${row.n} channel debt(s) were settled ` +
            `per call; their lane position would be lost. Refused.`,
        );
      }
    }
    await queryRunner.query(seqGuard(''));
    await queryRunner.query(FORMAT_GUARD_STRICT);
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "chk_payment_intents_channel_replacement"`,
    );
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        DROP COLUMN IF EXISTS "channel_replaced_per_call_at",
        DROP COLUMN IF EXISTS "replaced_channel_calls",
        DROP COLUMN IF EXISTS "replaced_channel_cumulative",
        DROP COLUMN IF EXISTS "replaced_channel_row_id"`);
  }
}

/** A harness without the channel columns (1793404800000 skipped its intents half) gets nothing. */
async function applies(queryRunner: QueryRunner): Promise<boolean> {
  return (
    (await queryRunner.hasTable('payment_intents')) &&
    (await queryRunner.hasColumn('payment_intents', 'voucher_format'))
  );
}

/** The on-chain deadline after a voucher's `expiresAt` (redeem grace + clock skew), per chain. */
const GRACE = (expr: string) => `${expr} + CASE
                          WHEN split_part(OLD.chain_id, ':', 1) = 'eip155'
                          THEN interval '7320 seconds'
                          ELSE interval '1920 seconds'
                        END`;

/** As 1793404800000 wrote it. */
const FORMAT_GUARD_STRICT = `
  CREATE OR REPLACE FUNCTION assert_voucher_format_is_immutable() RETURNS trigger AS $$
  BEGIN
    IF NEW."voucher_format" IS DISTINCT FROM OLD."voucher_format"
       OR NEW."channel_row_id" IS DISTINCT FROM OLD."channel_row_id"
       OR NEW."channel_cumulative" IS DISTINCT FROM OLD."channel_cumulative"
       OR NEW."channel_calls" IS DISTINCT FROM OLD."channel_calls" THEN
      RAISE EXCEPTION 'payment_intents.voucher_format and the channel position are immutable';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql`;

/** …plus the one move of a channel debt to the per-call door, its lane position kept apart. */
const FORMAT_GUARD_WITH_REPLACEMENT = `
  CREATE OR REPLACE FUNCTION assert_voucher_format_is_immutable() RETURNS trigger AS $$
  DECLARE
    moved boolean := COALESCE(OLD."voucher_format" = 'CHANNEL' AND NEW."voucher_format" = 'PER_CALL'
      AND OLD."replaced_channel_row_id" IS NULL
      AND NEW."channel_row_id" IS NULL AND NEW."channel_cumulative" IS NULL
      AND NEW."channel_calls" IS NULL
      AND NEW."replaced_channel_row_id" IS NOT DISTINCT FROM OLD."channel_row_id"
      AND NEW."replaced_channel_cumulative" IS NOT DISTINCT FROM OLD."channel_cumulative"
      AND NEW."replaced_channel_calls" IS NOT DISTINCT FROM OLD."channel_calls"
      AND NEW."channel_replaced_per_call_at" IS NOT NULL, false);
  BEGIN
    IF NOT moved AND (
         NEW."voucher_format" IS DISTINCT FROM OLD."voucher_format"
         OR NEW."channel_row_id" IS DISTINCT FROM OLD."channel_row_id"
         OR NEW."channel_cumulative" IS DISTINCT FROM OLD."channel_cumulative"
         OR NEW."channel_calls" IS DISTINCT FROM OLD."channel_calls"
         OR NEW."replaced_channel_row_id" IS DISTINCT FROM OLD."replaced_channel_row_id"
         OR NEW."replaced_channel_cumulative" IS DISTINCT FROM OLD."replaced_channel_cumulative"
         OR NEW."replaced_channel_calls" IS DISTINCT FROM OLD."replaced_channel_calls"
         OR NEW."channel_replaced_per_call_at" IS DISTINCT FROM OLD."channel_replaced_per_call_at") THEN
      RAISE EXCEPTION 'payment_intents.voucher_format and the channel position are immutable';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql`;

/**
 * A channel debt's first seq: lapsed, not being replaced, moving to PER_CALL,
 * and nothing of its lane still settleable on chain.
 */
const CHANNEL_REPLACEMENT_BRANCH = `
           AND NOT COALESCE((OLD.rail = 'RAIL_B_VOUCHER'
                    AND OLD.voucher_format = 'CHANNEL'
                    AND NEW.voucher_format = 'PER_CALL'
                    AND OLD.voucher_seq IS NULL
                    AND NEW.voucher_seq IS NOT NULL
                    AND OLD.redemption_lapsed_at IS NOT NULL
                    AND OLD.redemption_replaced_at IS NULL
                    AND NEW.redemption_replaced_at IS NOT NULL
                    AND now() > ${GRACE('OLD.expires_at')}
                    AND NOT EXISTS (
                      SELECT 1 FROM "channel_vouchers" v
                       WHERE v."channel_row_id" = OLD.channel_row_id
                         AND v."cumulative" >= OLD.channel_cumulative
                         AND now() <= ${GRACE('to_timestamp(v."expires_at")')})), false)`;

/** `assert_voucher_seq_is_immutable` as 1762400000070 wrote it, plus `extra`. */
function seqGuard(extra: string): string {
  return `
      CREATE OR REPLACE FUNCTION assert_voucher_seq_is_immutable()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.voucher_seq IS DISTINCT FROM OLD.voucher_seq
           AND NOT (OLD.rail = 'RAIL_B_VOUCHER'
                    AND OLD.voucher_seq IS NOT NULL
                    AND NEW.voucher_seq IS NOT NULL
                    AND NEW.voucher_seq > OLD.voucher_seq
                    AND OLD.redemption_lapsed_at IS NOT NULL
                    AND OLD.redemption_replaced_at IS NULL
                    AND NEW.redemption_replaced_at IS NOT NULL
                    AND now() > ${GRACE('OLD.expires_at')})${extra} THEN
          RAISE EXCEPTION
            'payment_intents.voucher_seq is immutable; changing it returns a spent voucher to circulation (only a lapsed debt past its old voucher''s on-chain deadline may take a higher replacement seq)'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
}
