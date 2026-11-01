import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A channel refund sent in pieces (final review 2026-11-01 MF-1 / X-1).
 *
 * A collect pays matured buckets oldest first, so the money a dispute keeps
 * can sit partly in each bucket of the lane. Such a refund is sent as one
 * piece per bucket, ONE PIECE PER TRANSACTION, each with its own deterministic
 * `refundId` (`channelRefundPieceId(intentId, index)`; piece 0 keeps the
 * single-piece id). Each piece is recorded in `channel_txs` as today:
 *
 * - `piece_index`: which piece the record sends (`NULL` = 0, the records
 *   written before this migration);
 * - `amount`: the piece's amount (the whole call's for a single piece);
 * - status `PARTIAL`: the piece landed but the call is not refunded in full
 *   yet. It is not "live", so the next piece of the same call can be
 *   recorded; the last piece's record is `LANDED` (still live, so the unique
 *   index keeps refusing any further refund of the call).
 *
 * `channel_txs` is small and new (1793404800000): metadata-only DDL with a
 * 5 s `lock_timeout` (retry the deploy on a timeout).
 */
export class ChannelRefundPieces1793404800050 implements MigrationInterface {
  name = 'ChannelRefundPieces1793404800050';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('channel_txs'))) return;
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE "channel_txs" ADD COLUMN IF NOT EXISTS "piece_index" integer NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "channel_txs" DROP CONSTRAINT IF EXISTS "chk_channel_txs_status"`,
    );
    await queryRunner.query(`
      ALTER TABLE "channel_txs" ADD CONSTRAINT "chk_channel_txs_status"
        CHECK ("status" IN ('PENDING', 'SENT', 'LANDED', 'PARTIAL', 'DROPPED'))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('channel_txs'))) return;
    const [row] = (await queryRunner.query(
      `SELECT COUNT(*)::int AS "n" FROM "channel_txs" WHERE "status" = 'PARTIAL' OR "piece_index" > 0`,
    )) as { n: number }[];
    if (Number(row?.n ?? 0) > 0) {
      throw new Error('channel refunds were sent in pieces; refusing to drop their records');
    }
    await queryRunner.query(
      `ALTER TABLE "channel_txs" DROP CONSTRAINT IF EXISTS "chk_channel_txs_status"`,
    );
    await queryRunner.query(`
      ALTER TABLE "channel_txs" ADD CONSTRAINT "chk_channel_txs_status"
        CHECK ("status" IN ('PENDING', 'SENT', 'LANDED', 'DROPPED'))`);
    await queryRunner.query(`ALTER TABLE "channel_txs" DROP COLUMN IF EXISTS "piece_index"`);
  }
}
