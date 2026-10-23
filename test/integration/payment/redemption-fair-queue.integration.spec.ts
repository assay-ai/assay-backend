import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { VOUCHER_REDEMPTION_BATCH } from '@modules/payment/constants/voucher-redemption.constants';
import { PaymentIntentStatus, PaymentRail } from '@modules/payment/ports/payment.types';
import {
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
} from '@modules/payment/ports/voucher-redeemer.port';
import { VoucherRedemptionService } from '@modules/payment/services/voucher-redemption.service';

import { noBlocks } from '../../unit/helpers/blocklist';
import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

/**
 * Review 2026-10-23 I-1 against real Postgres: on a chain that admits any seq
 * order (`eip155`, D-23) nothing holds a payer's rows back any more, so more
 * than a batch of rows the chain keeps refusing as retryable — one payer with
 * a low address, one provider below its minimum stake — used to fill the
 * `LIMIT` of every pass for up to two hours. The queue now backs those rows
 * off and fills the batch round-robin by payer and by provider.
 */
const DATABASE = 'assay_redemption_fair_queue_test';
const CHAIN = 'eip155:84532';
const ASSET = `${CHAIN}/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e`;
// Sorts first under the old `(agent_account, voucher_seq)` order.
const STUCK = `${CHAIN}:0x0000000000000000000000000000000000000AbC`;
const HONEST = `${CHAIN}:0x9999999999999999999999999999999999999999`;
const STUCK_PAYEE = `${CHAIN}:0x5555555555555555555555555555555555555555`;
const HONEST_PAYEE = `${CHAIN}:0x6666666666666666666666666666666666666666`;
const STUCK_ROWS = VOUCHER_REDEMPTION_BATCH + 20;

describe('redemption queue fairness on an any-order chain, against a real database', () => {
  let dataSource: DataSource;
  let payments: PaymentIntentRepository;
  const org = randomUUID();
  const stuckProvider = randomUUID();
  const honestProvider = randomUUID();

  async function seed(
    agentAccount: string,
    seq: number,
    providerId: string,
    providerAccount: string,
    expiresIn = '5 minutes',
  ): Promise<string> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO payment_intents (
         id, organization_id, status, agent_id, agent_account, provider_id, provider_account,
         tool_id, rail, call_id, call_class, asset_id, decimals, price_amount, provider_amount,
         platform_fee, request_hash, chain_id, expires_at, voucher_seq, voucher_signature,
         voucher_resource_hash, voucher_issued_at, hold_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PAID', $11, 6, 1000, 800, 200,
               $12, $13, now() + $19::interval, $14, $15, $16, $17, $18)`,
      [
        id,
        org,
        PaymentIntentStatus.SETTLED,
        randomUUID(),
        agentAccount,
        providerId,
        providerAccount,
        randomUUID(),
        PaymentRail.RAIL_B_VOUCHER,
        randomUUID(),
        ASSET,
        `sha256:${'ab'.repeat(32)}`,
        CHAIN,
        String(seq),
        `0x${'12'.repeat(65)}`,
        `sha256:${'cd'.repeat(32)}`,
        String(Math.floor(Date.now() / 1000)),
        randomUUID(),
        expiresIn,
      ],
    );
    return id;
  }

  const find = (orderedBySeq: boolean) =>
    payments.findAwaitingRedemption(
      ASSET,
      PaymentIntentStatus.SETTLED,
      PaymentRail.RAIL_B_VOUCHER,
      VOUCHER_REDEMPTION_BATCH,
      undefined,
      { orderedBySeq },
    );

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    payments = new PaymentIntentRepository(dataSource);
    await dataSource.query(`ALTER TABLE payment_intents DISABLE TRIGGER ALL`);
  });
  afterAll(async () => dataSource?.destroy());

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM payment_intents WHERE organization_id = $1`, [org]);
    // More than a batch of one payer's rows, all to one provider, every one
    // already refused as retryable (the provider unbonded below the minimum).
    for (let seq = 1; seq <= STUCK_ROWS; seq += 1) {
      await seed(STUCK, seq, stuckProvider, STUCK_PAYEE);
    }
    await dataSource.query(
      `UPDATE payment_intents SET redemption_last_error = 'ProviderBelowMinimumStake'
        WHERE agent_account = $1`,
      [STUCK],
    );
    await seed(HONEST, 1, honestProvider, HONEST_PAYEE);
  });

  it('the old order lets the stuck payer fill the whole batch (the starvation)', async () => {
    const rows = await find(true);
    expect(rows).toHaveLength(VOUCHER_REDEMPTION_BATCH);
    expect(rows.every((row) => row.agentAccount === STUCK)).toBe(true);
  });

  it('round-robin: the honest row is in the batch, first, ahead of 120 retry-stuck rows', async () => {
    const rows = await find(false);
    expect(rows).toHaveLength(VOUCHER_REDEMPTION_BATCH);
    expect(rows[0]).toMatchObject({ agentAccount: HONEST, voucherSeq: '1' });
    // The projection is exactly the queue's: nothing of the ranking leaks out.
    expect(Object.keys(rows[0]).sort()).toEqual(Object.keys(rows[1]).sort());
    expect(rows[0]).not.toHaveProperty('payerRound');
  });

  it('round-robin by provider too: many payers of one provider do not take the batch', async () => {
    // 120 distinct payers, one provider, plus the honest row of another.
    await dataSource.query(`DELETE FROM payment_intents WHERE agent_account = $1`, [STUCK]);
    for (let n = 1; n <= STUCK_ROWS; n += 1) {
      await seed(`${CHAIN}:0x${n.toString(16).padStart(40, '0')}`, 1, stuckProvider, STUCK_PAYEE);
    }
    const rows = await find(false);
    expect(rows[0]).toMatchObject({ agentAccount: HONEST });
  });

  it('a row in its back-off is left out; the next pass meets the rows behind it', async () => {
    const first = await find(false);
    for (const row of first) await payments.recordRedemptionRetry(row.organizationId, row.id);

    const second = await find(false);
    const firstIds = new Set(first.map((row) => row.id));
    expect(second.length).toBe(STUCK_ROWS + 1 - VOUCHER_REDEMPTION_BATCH);
    expect(second.every((row) => !firstIds.has(row.id))).toBe(true);
  });

  it('the back-off grows to 10 minutes at most, and never past the voucher’s last pass', async () => {
    const id = await seed(HONEST, 2, honestProvider, HONEST_PAYEE, '2 hours');
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await payments.recordRedemptionRetry(org, id);
      const [row] = (await dataSource.query(
        `SELECT extract(epoch FROM redemption_retry_at - now())::int AS "delay"
           FROM payment_intents WHERE id = $1`,
        [id],
      )) as { delay: number }[];
      delays.push(row.delay);
    }
    expect(delays).toEqual([60, 120, 240, 480, 600, 600]);

    // Deadline = expires_at + 7,200 s = now + 200 s; its last pass is 60 s
    // before it. The third back-off (240 s) would overshoot: it is capped there.
    const late = await seed(HONEST, 3, honestProvider, HONEST_PAYEE, '-7000 seconds');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await payments.recordRedemptionRetry(org, late);
    }
    const [capped] = (await dataSource.query(
      `SELECT extract(epoch FROM (expires_at + interval '7200 seconds') - redemption_retry_at)::int
              AS "beforeDeadline"
         FROM payment_intents WHERE id = $1`,
      [late],
    )) as { beforeDeadline: number }[];
    expect(capped.beforeDeadline).toBe(60);

    // Already inside its last pass: no back-off at all, it is met every pass.
    const last = await seed(HONEST, 4, honestProvider, HONEST_PAYEE, '-7170 seconds');
    await payments.recordRedemptionRetry(org, last);
    const [now] = (await dataSource.query(
      `SELECT extract(epoch FROM redemption_retry_at - now())::int AS "delay"
         FROM payment_intents WHERE id = $1`,
      [last],
    )) as { delay: number }[];
    expect(now.delay).toBe(0);
  });

  it('the pass attempts the honest voucher in the same pass as 120 retry-stuck ones', async () => {
    const attempted: RedeemVoucherRequest[] = [];
    const redeemer = {
      maxBatchSize: 1,
      requiresAscendingSeq: () => false,
      redeemBatch: async () => [],
      async redeem(request: RedeemVoucherRequest): Promise<RedeemOutcome> {
        attempted.push(request);
        return request.payer === STUCK
          ? {
              kind: RedeemOutcomeKind.RETRY,
              signature: null,
              programError: 'ProviderBelowMinimumStake',
            }
          : { kind: RedeemOutcomeKind.RETRY, signature: null, programError: 'EscrowInsufficient' };
      },
    };
    const service = new VoucherRedemptionService(
      payments,
      { commitRedeemedHold: jest.fn(), releaseHold: jest.fn() } as never,
      redeemer as never,
      { emit: async () => undefined } as never,
      noBlocks(),
      () => Date.now(),
    );

    await service.run(ASSET as never);

    expect(attempted.some((request) => request.payer === HONEST)).toBe(true);
    // Every row it was refused on is backed off.
    const [{ waiting }] = (await dataSource.query(
      `SELECT count(*)::int AS "waiting" FROM payment_intents
        WHERE organization_id = $1 AND redemption_retry_at > now()`,
      [org],
    )) as { waiting: number }[];
    expect(waiting).toBe(VOUCHER_REDEMPTION_BATCH);
  });
});
