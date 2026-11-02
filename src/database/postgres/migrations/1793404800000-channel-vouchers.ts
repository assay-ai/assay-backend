import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The channel door's data model (spec P2 v3.1 §5.1, SPEC-W2 §4, §8).
 *
 * - `voucher_channels`: one row per channel (payer, signer, provider,
 *   channelId), bound at open to the organization, agent and credential that
 *   opened it; what was accepted, what the chain settled, and whether a
 *   settlement is in flight (`settling_to`), and an urgent round asked for
 *   by admission or a debt replacement (`urgent_requested_at`; the API and the
 *   scheduler are separate processes).
 * - `channel_vouchers`: every voucher admitted on a channel, so a round can
 *   settle the newest one whose calls are all terminal.
 * - `channel_settlements`: one row per settle item sent, with what it charged
 *   and waived, the bucket it landed in and what was later collected, refunded
 *   or left for a dispute.
 * - `payment_intents.voucher_format` (`PER_CALL` | `CHANNEL`, immutable) and
 *   the channel columns: a channel call is a rail-B intent like any other (its
 *   hold, verdict, dispute and earnings run the same paths); only redemption,
 *   collect and refund are routed by the format, never by probing the chain.
 * - `providers.payout_cadence`: `HOURLY` (only when $25 is ready) or
 *   `EVERY_6_HOURS` (the default). No 24 h option (SPEC-W2 §8).
 *
 * Nothing here changes a per-call row: every existing row is `PER_CALL`, and
 * the CHECK keeps the channel columns null on it.
 */
export class ChannelVouchers1793404800000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // Fail fast instead of queueing every paid call behind a long transaction:
    // the ALTERs below take ACCESS EXCLUSIVE on `payment_intents` / `providers`
    // (metadata only, no scan) until this migration commits (re-review F3).
    // Retry the migration if it times out.
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "voucher_channels" (
        "id" uuid PRIMARY KEY,
        "chain_id" character varying(64) NOT NULL,
        "asset_id" character varying(256) NOT NULL,
        "payer" character varying(256) NOT NULL,
        "signer" character varying(256) NOT NULL,
        "provider_account" character varying(256) NOT NULL,
        "provider_id" uuid NOT NULL,
        "channel_id" character(66) NOT NULL,
        "channel_key" character(66) NOT NULL,
        "organization_id" uuid NOT NULL,
        "agent_id" uuid NOT NULL,
        "credential_id" uuid NULL,
        "status" character varying(12) NOT NULL DEFAULT 'OPEN',
        "status_reason" character varying(32) NULL,
        "last_accepted_cumulative" numeric(20, 0) NOT NULL DEFAULT 0,
        "last_accepted_calls" integer NOT NULL DEFAULT 0,
        "last_issued_at" bigint NULL,
        "settled_cumulative" numeric(20, 0) NOT NULL DEFAULT 0,
        "settled_calls" integer NOT NULL DEFAULT 0,
        "settling_to" numeric(20, 0) NULL,
        "settling_since" timestamptz NULL,
        "oldest_unsettled_at" timestamptz NULL,
        "deadline_at" timestamptz NULL,
        "last_settled_at" timestamptz NULL,
        "last_collected_at" timestamptz NULL,
        "opened_on_chain" boolean NOT NULL DEFAULT false,
        "signer_valid_until" bigint NULL,
        "urgent_requested_at" timestamptz NULL,
        "urgent_reason" character varying(16) NULL,
        "last_skip_reason" character varying(32) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_voucher_channels_status"
          CHECK ("status" IN ('OPEN', 'ROTATED', 'REVOKED', 'DESYNC', 'CLOSED')),
        CONSTRAINT "chk_voucher_channels_monotone"
          CHECK ("settled_cumulative" <= "last_accepted_cumulative"
                 AND ("settling_to" IS NULL OR "settling_to" > "settled_cumulative")),
        CONSTRAINT "uq_voucher_channels_lane"
          UNIQUE ("chain_id", "payer", "signer", "provider_account", "channel_id"),
        CONSTRAINT "uq_voucher_channels_key" UNIQUE ("chain_id", "channel_key")
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_voucher_channels_payer"
         ON "voucher_channels" ("payer", "asset_id") WHERE "status" <> 'CLOSED'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_voucher_channels_pending"
         ON "voucher_channels" ("asset_id")
         WHERE "last_accepted_cumulative" > "settled_cumulative"`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "channel_vouchers" (
        "id" uuid PRIMARY KEY,
        "channel_row_id" uuid NOT NULL REFERENCES "voucher_channels" ("id"),
        "intent_id" uuid NULL,
        "cumulative" numeric(20, 0) NOT NULL,
        "calls" integer NOT NULL,
        "issued_at" bigint NOT NULL,
        "expires_at" bigint NOT NULL,
        "signature" character varying(132) NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_channel_vouchers_pair" UNIQUE ("channel_row_id", "cumulative", "issued_at"),
        CONSTRAINT "chk_channel_vouchers_life"
          CHECK ("expires_at" > "issued_at" AND "expires_at" - "issued_at" <= 300)
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_channel_vouchers_channel"
         ON "channel_vouchers" ("channel_row_id", "cumulative" DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "channel_settlements" (
        "id" uuid PRIMARY KEY,
        "channel_row_id" uuid NOT NULL REFERENCES "voucher_channels" ("id"),
        "voucher_id" uuid NOT NULL REFERENCES "channel_vouchers" ("id"),
        "from_settled" numeric(20, 0) NOT NULL,
        "to_cumulative" numeric(20, 0) NOT NULL,
        "from_calls" integer NOT NULL,
        "to_calls" integer NOT NULL,
        "charge" numeric(20, 0) NOT NULL,
        "waived" numeric(20, 0) NOT NULL,
        "tx_refs" text[] NOT NULL DEFAULT '{}',
        "maturity_hour" integer NULL,
        "take_rate_bps" integer NULL,
        "collected" numeric(20, 0) NOT NULL DEFAULT 0,
        "refunded" numeric(20, 0) NOT NULL DEFAULT 0,
        "left_amount" numeric(20, 0) NOT NULL DEFAULT 0,
        "status" character varying(10) NOT NULL DEFAULT 'PENDING',
        "skip_reason" character varying(32) NULL,
        "trigger" character varying(16) NULL,
        "charged_intent_ids" uuid[] NOT NULL DEFAULT '{}',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "landed_at" timestamptz NULL,
        CONSTRAINT "chk_channel_settlements_status"
          CHECK ("status" IN ('PENDING', 'SENT', 'LANDED', 'SKIPPED', 'DROPPED')),
        CONSTRAINT "chk_channel_settlements_step"
          CHECK ("to_cumulative" > "from_settled"
                 AND "charge" + "waived" = "to_cumulative" - "from_settled"
                 AND "collected" + "refunded" <= "charge")
      )`);
    // One live settlement per (channel, target): a skipped or dropped one may be retried.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_channel_settlements_target"
         ON "channel_settlements" ("channel_row_id", "to_cumulative")
         WHERE "status" IN ('PENDING', 'SENT', 'LANDED')`,
    );

    // Collects, refunds and unpaid claims sent with the redeemer key, recorded
    // BEFORE the broadcast (the hash from `beforeBroadcast`), so an outcome this
    // process never saw (a receipt timeout, a crash) is read back from the
    // chain instead of being sent again (review 2026-10-31 H1/H2). A refund
    // is one call's, and at most one is live per call: a channel refund has no
    // id the chain could refuse a repeat on.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "channel_txs" (
        "id" uuid PRIMARY KEY,
        "kind" character varying(8) NOT NULL,
        "asset_id" character varying(256) NOT NULL,
        "intent_id" uuid NULL,
        "channel_row_ids" uuid[] NOT NULL DEFAULT '{}',
        "amount" numeric(20, 0) NULL,
        "tx_refs" text[] NOT NULL DEFAULT '{}',
        "status" character varying(10) NOT NULL DEFAULT 'PENDING',
        "detail" character varying(64) NULL,
        "drop_seen_block" numeric(20, 0) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "landed_at" timestamptz NULL,
        CONSTRAINT "chk_channel_txs_kind" CHECK ("kind" IN ('COLLECT', 'REFUND')),
        CONSTRAINT "chk_channel_txs_status"
          CHECK ("status" IN ('PENDING', 'SENT', 'LANDED', 'DROPPED')),
        CONSTRAINT "chk_channel_txs_refund_intent" CHECK ("kind" <> 'REFUND' OR "intent_id" IS NOT NULL)
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_channel_txs_live_refund"
         ON "channel_txs" ("intent_id")
         WHERE "kind" = 'REFUND' AND "status" IN ('PENDING', 'SENT', 'LANDED')`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_channel_txs_in_flight"
         ON "channel_txs" ("asset_id", "created_at") WHERE "status" IN ('PENDING', 'SENT')`,
    );

    // Who signed each recorded channel transaction, at which nonce: a hash with
    // no receipt is "dropped" only once the sender's confirmed nonce is past it
    // (never on a timer), so nothing is re-sent while it could still land.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "channel_tx_attempts" (
        "tx_hash" character varying(80) PRIMARY KEY,
        "sender" character varying(42) NOT NULL,
        "nonce" numeric(20, 0) NOT NULL,
        "recorded_at" timestamptz NOT NULL DEFAULT now()
      )`);

    // Payouts the escrow set aside after the token refused the transfer
    // (`TransferDeferred`: an issuer-frozen provider or treasury). Booked as
    // collected in the ledger, NOT in the recipient's wallet: shown as unpaid
    // until an operator's claim (`claimUnpaid`, override M-3) pays them.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "channel_unpaid_payouts" (
        "id" uuid PRIMARY KEY,
        "asset_id" character varying(256) NOT NULL,
        "address" character varying(42) NOT NULL,
        "provider_id" uuid NULL,
        "amount" numeric(20, 0) NOT NULL,
        "tx_ref" character varying(80) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "claim_requested_at" timestamptz NULL,
        "claimed_at" timestamptz NULL,
        "claim_tx_ref" character varying(80) NULL,
        CONSTRAINT "uq_channel_unpaid_payouts_event" UNIQUE ("tx_ref", "address", "amount")
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_channel_unpaid_payouts_open"
         ON "channel_unpaid_payouts" ("asset_id", "address") WHERE "claimed_at" IS NULL`,
    );

    // The reconciler's foreign-transaction scan position, per asset: a restart
    // resumes where it stopped instead of rescanning only a recent window.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "channel_scan_cursors" (
        "asset_id" character varying(256) PRIMARY KEY,
        "scanned_to" bigint NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);

    // A harness that builds only part of the schema (no `payment_intents`, or one
    // from before `voucher_seq`) gets the provider half alone; production has both.
    const intents =
      (await queryRunner.hasTable('payment_intents')) &&
      (await queryRunner.hasColumn('payment_intents', 'voucher_seq'));
    if (intents) {
      await queryRunner.query(`
        ALTER TABLE "payment_intents"
          ADD COLUMN IF NOT EXISTS "voucher_format" character varying(10) NOT NULL DEFAULT 'PER_CALL',
          ADD COLUMN IF NOT EXISTS "channel_row_id" uuid NULL,
          ADD COLUMN IF NOT EXISTS "channel_cumulative" numeric(20, 0) NULL,
          ADD COLUMN IF NOT EXISTS "channel_calls" integer NULL,
          ADD COLUMN IF NOT EXISTS "channel_settlement_id" uuid NULL,
          ADD COLUMN IF NOT EXISTS "waived_reason" character varying(32) NULL`);
      // NOT VALID here (no scan while ACCESS EXCLUSIVE is held); the VALIDATE
      // scan runs in `ChannelVoucherIndexes1793404800010`, outside this
      // transaction, under SHARE UPDATE EXCLUSIVE, which does not block paid
      // calls (review M4, re-review F3).
      await queryRunner.query(`
        ALTER TABLE "payment_intents"
          ADD CONSTRAINT "chk_payment_intents_voucher_format" CHECK (
            ("voucher_format" = 'PER_CALL' AND "channel_row_id" IS NULL
               AND "channel_cumulative" IS NULL AND "channel_calls" IS NULL
               AND "channel_settlement_id" IS NULL)
            OR ("voucher_format" = 'CHANNEL' AND "rail" = 'RAIL_B_VOUCHER'
               AND "channel_row_id" IS NOT NULL AND "channel_cumulative" IS NOT NULL
               AND "channel_calls" IS NOT NULL AND "voucher_seq" IS NULL)) NOT VALID`);
      // The two `payment_intents` indexes are built CONCURRENTLY by
      // `ChannelVoucherIndexes1793404800010` (no wrapping transaction there).
      // A rail-B row is authorised by a seq (PER_CALL) or by its channel position
      // (CHANNEL; the CHECK above requires it): the seq rule now names the format.
      await queryRunner.query(`
        CREATE OR REPLACE FUNCTION assert_rail_b_intent_has_voucher_seq()
        RETURNS trigger AS $$
        BEGIN
          IF NEW.rail = 'RAIL_B_VOUCHER' AND NEW.voucher_format = 'PER_CALL' AND NEW.voucher_seq IS NULL THEN
            RAISE EXCEPTION
              'a RAIL_B_VOUCHER payment intent must record the voucher seq it was authorised by'
              USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql`);
      // The format is fixed at insert: a row routed one way must never be re-routed.
      await queryRunner.query(`
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
        $$ LANGUAGE plpgsql`);
      await queryRunner.query(`
        CREATE TRIGGER "trg_payment_intents_voucher_format_immutable"
          BEFORE UPDATE ON "payment_intents"
          FOR EACH ROW EXECUTE FUNCTION assert_voucher_format_is_immutable()`);
    }

    await queryRunner.query(`
      ALTER TABLE IF EXISTS "providers"
        ADD COLUMN IF NOT EXISTS "payout_cadence" character varying(16) NOT NULL DEFAULT 'EVERY_6_HOURS',
        ADD COLUMN IF NOT EXISTS "payout_cadence_changed_at" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "last_payout_at" timestamptz NULL`);
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "providers"
        ADD CONSTRAINT "chk_providers_payout_cadence"
          CHECK ("payout_cadence" IN ('HOURLY', 'EVERY_6_HOURS')) NOT VALID`);
  }

  /**
   * Refuses while any channel call or channel exists: dropping the format
   * columns would turn every channel call into a per-call row with no seq
   * (and no route to its money), and the channel tables hold what the chain
   * owes back. Drain and close every channel first (review 2026-10-31 M4).
   */
  async down(queryRunner: QueryRunner): Promise<void> {
    const intents =
      (await queryRunner.hasTable('payment_intents')) &&
      (await queryRunner.hasColumn('payment_intents', 'voucher_format'));
    if (intents) {
      const [row] = (await queryRunner.query(
        `SELECT COUNT(*)::int AS "n" FROM "payment_intents" WHERE "voucher_format" = 'CHANNEL'`,
      )) as { n: number }[];
      if (Number(row?.n ?? 0) > 0) {
        throw new Error(
          `ChannelVouchers1793404800000 down: ${row.n} channel call(s) exist; it would strand their ` +
            `money. Refused.`,
        );
      }
    }
    if (await queryRunner.hasTable('voucher_channels')) {
      const [row] = (await queryRunner.query(
        `SELECT COUNT(*)::int AS "n" FROM "voucher_channels"`,
      )) as { n: number }[];
      if (Number(row?.n ?? 0) > 0) {
        throw new Error(`ChannelVouchers1793404800000 down: ${row.n} channel(s) exist. Refused.`);
      }
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "channel_scan_cursors"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "channel_tx_attempts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "channel_unpaid_payouts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "channel_txs"`);
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "providers" DROP CONSTRAINT IF EXISTS "chk_providers_payout_cadence"`,
    );
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "providers"
        DROP COLUMN IF EXISTS "last_payout_at",
        DROP COLUMN IF EXISTS "payout_cadence_changed_at",
        DROP COLUMN IF EXISTS "payout_cadence"`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_payment_intents_voucher_format_immutable" ON "payment_intents"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS assert_voucher_format_is_immutable()`);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_rail_b_intent_has_voucher_seq()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.rail = 'RAIL_B_VOUCHER' AND NEW.voucher_seq IS NULL THEN
          RAISE EXCEPTION
            'a RAIL_B_VOUCHER payment intent must record the voucher seq it was authorised by'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payment_intents_channel_held"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_payment_intents_channel_cumulative"`);
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "chk_payment_intents_voucher_format"`,
    );
    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        DROP COLUMN IF EXISTS "waived_reason",
        DROP COLUMN IF EXISTS "channel_settlement_id",
        DROP COLUMN IF EXISTS "channel_calls",
        DROP COLUMN IF EXISTS "channel_cumulative",
        DROP COLUMN IF EXISTS "channel_row_id",
        DROP COLUMN IF EXISTS "voucher_format"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "channel_settlements"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "channel_vouchers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "voucher_channels"`);
  }
}
