import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

const DATABASE = 'x402_call_disputes_migration_test';

/**
 * `CallDisputes1761800000000` (G3.B1) applies, reverts and applies again on a
 * database built from every migration, and its constraints hold.
 */
describe('call disputes migration: up, down, up', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
  }, 300_000);
  afterAll(async () => dataSource?.destroy());

  const columns = async (): Promise<string[]> =>
    (
      (await dataSource.query(
        `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
          WHERE table_schema = 'public'
            AND ((table_name = 'disputes' AND column_name IN (
                   'intent_id', 'verdict_id', 'binding_id', 'tool_id', 'respondent_provider_id',
                   'evidence_snapshot', 'provider_response', 'provider_responded_at',
                   'refund_source', 'refund_state', 'refund_amount'))
              OR (table_name IN ('payment_intents', 'verification_records')
                  AND column_name = 'dispute_outcome'))
          ORDER BY 1`,
      )) as { c: string }[]
    ).map((row) => row.c);

  const last = async (): Promise<string> =>
    (
      (await dataSource.query(`SELECT name FROM migrations ORDER BY id DESC LIMIT 1`)) as {
        name: string;
      }[]
    )[0].name;

  it('reverts and reapplies cleanly', async () => {
    expect(await last()).toBe('CallDisputes1761800000000');
    expect(await columns()).toHaveLength(13);

    await dataSource.undoLastMigration({ transaction: 'each' });
    expect(await last()).toBe('ToolDraftIntegrity1761600000000');
    expect(await columns()).toEqual([]);

    await dataSource.runMigrations({ transaction: 'each' });
    expect(await last()).toBe('CallDisputes1761800000000');
    expect(await columns()).toHaveLength(13);
  });

  async function insertDispute(
    intentId: string,
    state: string,
    extra: { refundSource?: string | null; refundState?: string | null } = {},
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO disputes (organization_id, subject_type, subject_id, state, claim_type, reason,
                             opened_by, intent_id, respondent_provider_id, evidence_snapshot,
                             refund_source, refund_state)
       VALUES ($1, 'PAYMENT_INTENT', $2::text, $3, 'WRONG_DATA', '', 'agent', $2::uuid, $4, '{}'::jsonb,
               $5, $6)`,
      [
        randomUUID(),
        intentId,
        state,
        randomUUID(),
        extra.refundSource ?? null,
        extra.refundState ?? null,
      ],
    );
  }

  it('allows one open dispute per call, and any number of closed ones', async () => {
    const intentId = randomUUID();
    await insertDispute(intentId, 'WITHDRAWN');
    await insertDispute(intentId, 'REJECTED');
    await insertDispute(intentId, 'OPEN');
    await expect(insertDispute(intentId, 'OPEN')).rejects.toMatchObject({
      constraint: 'uq_disputes_open_call',
    });
  });

  it('refuses a half-written call dispute or refund', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO disputes (organization_id, subject_type, subject_id, state, claim_type,
                               reason, opened_by, intent_id)
         VALUES ($1, 'PAYMENT_INTENT', $2::text, 'OPEN', 'OTHER', '', 'agent', $2::uuid)`,
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({ constraint: 'chk_disputes_call_is_whole' });
    await expect(
      insertDispute(randomUUID(), 'UPHELD', { refundSource: 'PROVIDER_STAKE' }),
    ).rejects.toMatchObject({ constraint: 'chk_disputes_refund_is_whole' });
    await expect(
      insertDispute(randomUUID(), 'UPHELD', { refundSource: 'PLATFORM', refundState: 'REFUNDED' }),
    ).rejects.toMatchObject({ constraint: 'chk_disputes_refund_source' });
  });
});
