import { MigrationInterface, QueryRunner } from 'typeorm';

import { nonTransactionalStep } from '../non-transactional-migration';

/**
 * The VALIDATE of `chk_payment_intents_channel_replacement`, added `NOT VALID`
 * by `ChannelDebtPerCallReplacement1793404800030`, outside any transaction
 * like `ChannelVoucherIndexes1793404800010`: the scan runs under SHARE UPDATE
 * EXCLUSIVE and paid calls keep reading and writing (rev3 L-4). Skipped when
 * the constraint is absent (a harness without the channel schema) or already
 * valid, so a re-run is a no-op.
 */
const VALIDATE: readonly (readonly [string, string])[] = [
  ['payment_intents', 'chk_payment_intents_channel_replacement'],
];

export class ChannelReplacementCheckValidate1793404800040 implements MigrationInterface {
  name = 'ChannelReplacementCheckValidate1793404800040';

  transaction = false;

  /** With session timeouts and a run lock (final review ops F6). */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await nonTransactionalStep(queryRunner, this.name, () => this.upStep(queryRunner));
  }

  private async upStep(queryRunner: QueryRunner): Promise<void> {
    for (const [table, constraint] of VALIDATE) {
      const [found] = (await queryRunner.query(
        `SELECT convalidated FROM pg_constraint WHERE conname = $1`,
        [constraint],
      )) as { convalidated: boolean }[];
      if (found && !found.convalidated) {
        await queryRunner.query(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${constraint}"`);
      }
    }
  }

  /** Nothing to undo: a validated CHECK is the same CHECK; 030's `down` drops it. */
  public async down(): Promise<void> {
    // no-op
  }
}
