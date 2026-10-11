import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `voucher_admission_pauses`, one row per tightening instead of one per payer
 * (BUG-D1-07 review, findings 1 to 3 and 6).
 *
 * The first shape kept a single `paused_until` per payer, and every relay that
 * ended overwrote it: a second change of the same payer that was refused by
 * name lifted the first one's pause while the first was still in flight. Here
 * every relayed tightening writes its OWN row and ends only that row, so
 * admission stays paused while ANY row is live:
 *
 * - `delegate`: the delegate whose grant is changed, whose vouchers alone the
 *   change can strand; `NULL` for a change of the escrow's own limits, which
 *   pauses every voucher of the payer.
 * - `paused_until`: while the relay is pending, the latest instant its outcome
 *   can still be unknown (the relayer's queue wait plus its receipt timeout,
 *   and never before the signed request's own deadline). Once it has landed,
 *   `landed_at` + the chain-lag margin.
 * - `landed_at`: when the relay's receipt came back. An admission whose chain
 *   read was taken before `landed_at` + the chain-lag margin read the OLD caps
 *   and is refused, however late its insert comes.
 *
 * Every instant is the database's clock. A row in the past is inert; the hold
 * deletes the payer's old rows as it goes.
 *
 * The rows of the first shape are transient (two minutes at most) and are
 * dropped with it.
 */
export class VoucherAdmissionPausePerRequest1759600000006 implements MigrationInterface {
  name = 'VoucherAdmissionPausePerRequest1759600000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "voucher_admission_pauses"`);
    await queryRunner.query(
      `CREATE TABLE "voucher_admission_pauses" (` +
        `"id" uuid NOT NULL DEFAULT gen_random_uuid(), ` +
        `"payer_account" varchar(256) NOT NULL, ` +
        `"delegate" varchar(256), ` +
        `"paused_until" timestamptz NOT NULL, ` +
        `"landed_at" timestamptz, ` +
        `"created_at" timestamptz NOT NULL DEFAULT now(), ` +
        `CONSTRAINT "pk_voucher_admission_pauses" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_voucher_admission_pauses_payer" ` +
        `ON "voucher_admission_pauses" ("payer_account", "paused_until")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "voucher_admission_pauses"`);
    await queryRunner.query(
      `CREATE TABLE "voucher_admission_pauses" (` +
        `"payer_account" varchar(256) NOT NULL, ` +
        `"paused_until" timestamptz NOT NULL, ` +
        `"updated_at" timestamptz NOT NULL DEFAULT now(), ` +
        `CONSTRAINT "pk_voucher_admission_pauses" PRIMARY KEY ("payer_account"))`,
    );
  }
}
