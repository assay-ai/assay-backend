import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { VOUCHER_REDEMPTION_BATCH } from '@modules/payment/constants/voucher-redemption.constants';
import { PaymentIntentStatus, PaymentRail } from '@modules/payment/ports/payment.types';
import {
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
} from '@modules/payment/ports/voucher-redeemer.port';
import { VoucherRedemptionService } from '@modules/payment/services/voucher-redemption.service';

import { blocklistOf } from '../../unit/helpers/blocklist';
import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

/**
 * Audit E-1 against real Postgres: a blocked party's rows are left out of the
 * redemption query BEFORE its `LIMIT`, so more than a batch of held rows at
 * the head of the `(agent_account, voucher_seq)` order cannot starve the
 * honest buyer behind them, for the platform blocklist and the on-chain one.
 */
const DATABASE = 'x402_redemption_blocked_queue_test';
const CHAIN = 'eip155:84532';
const ASSET = `${CHAIN}/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e`;
// Sorts before HONEST so its rows fill the head of the queue.
const BLOCKED = `${CHAIN}:0x0000000000000000000000000000000000000AbC`;
const HONEST = `${CHAIN}:0x9999999999999999999999999999999999999999`;
const PAYEE = `${CHAIN}:0x5555555555555555555555555555555555555555`;
const OTHER_PAYEE = `${CHAIN}:0x6666666666666666666666666666666666666666`;

describe('redemption queue with blocked parties, against a real database', () => {
  let dataSource: DataSource;
  let payments: PaymentIntentRepository;
  const org = randomUUID();
  const provider = randomUUID();
  const otherProvider = randomUUID();

  async function seed(
    agentAccount: string,
    seq: number,
    providerId = provider,
    providerAccount = PAYEE,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO payment_intents (
         id, organization_id, status, agent_id, agent_account, provider_id, provider_account,
         tool_id, rail, call_id, call_class, asset_id, decimals, price_amount, provider_amount,
         platform_fee, request_hash, chain_id, expires_at, voucher_seq, voucher_signature,
         voucher_resource_hash, voucher_issued_at, hold_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PAID', $11, 6, 1000, 800, 200,
               $12, $13, now() + interval '5 minutes', $14, $15, $16, $17, $18)`,
      [
        randomUUID(),
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
      ],
    );
  }

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    payments = new PaymentIntentRepository(dataSource);
    // Seeded as rows, not through the voucher path: triggers and foreign keys
    // are what the voucher path satisfies, and this test is about the query.
    await dataSource.query(`ALTER TABLE payment_intents DISABLE TRIGGER ALL`);
    for (let seq = 1; seq <= VOUCHER_REDEMPTION_BATCH + 20; seq += 1) await seed(BLOCKED, seq);
    await seed(HONEST, 1);
    await seed(HONEST, 2, otherProvider, OTHER_PAYEE);
    await seed(HONEST, 3);
  });
  afterAll(async () => dataSource?.destroy());

  const find = (exclude?: Parameters<PaymentIntentRepository['findAwaitingRedemption']>[4]) =>
    payments.findAwaitingRedemption(
      ASSET,
      PaymentIntentStatus.SETTLED,
      PaymentRail.RAIL_B_VOUCHER,
      VOUCHER_REDEMPTION_BATCH,
      exclude,
    );

  it('without exclusions the blocked payer fills the whole batch (the starvation)', async () => {
    const rows = await find();
    expect(rows).toHaveLength(VOUCHER_REDEMPTION_BATCH);
    expect(rows.every((row) => row.agentAccount === BLOCKED)).toBe(true);
  });

  it('leaves out a payer blocked on the platform list, matched by its wallet key', async () => {
    const rows = await find({
      organizationIds: [],
      walletKeys: ['eip155:0x0000000000000000000000000000000000000abc'],
      chainAccounts: [],
    });
    expect(rows.map((row) => [row.agentAccount, row.voucherSeq])).toEqual([
      [HONEST, '1'],
      [HONEST, '2'],
      [HONEST, '3'],
    ]);
  });

  it('leaves out a payer blocked on chain, case-insensitively', async () => {
    const rows = await find({
      organizationIds: [],
      walletKeys: [],
      chainAccounts: [BLOCKED.toLowerCase()],
    });
    expect(rows.map((row) => row.agentAccount)).toEqual([HONEST, HONEST, HONEST]);
  });

  it('a blocked provider or payee does not hold its row: the pass forfeits it instead', async () => {
    // Finding 14: holding a provider-blocked row until it expired ended in the
    // platform paying the provider. The row is returned, so the pass can make
    // the provider forfeit it at once, and the payer's later seqs come too.
    const onlyHonest = await find({
      organizationIds: [otherProvider],
      walletKeys: [
        'eip155:0x0000000000000000000000000000000000000abc',
        `eip155:${OTHER_PAYEE.split(':')[2].toLowerCase()}`,
      ],
      chainAccounts: [OTHER_PAYEE.toLowerCase()],
    });
    expect(onlyHonest.map((row) => row.voucherSeq)).toEqual(['1', '2', '3']);
  });

  it('the redemption pass redeems the honest buyer behind more than a batch of held rows', async () => {
    const calls: RedeemVoucherRequest[] = [];
    const redeemer = {
      maxBatchSize: 1,
      redeemBatch: async () => [],
      async redeem(request: RedeemVoucherRequest): Promise<RedeemOutcome> {
        calls.push(request);
        return { kind: RedeemOutcomeKind.RETRY, signature: null, programError: null };
      },
    };
    const service = new VoucherRedemptionService(
      payments,
      { commitRedeemedHold: jest.fn(), releaseHold: jest.fn() } as never,
      redeemer as never,
      { emit: async () => undefined } as never,
      blocklistOf({ kind: BlockSubjectKind.WALLET, subject: BLOCKED }),
      () => Date.now(),
      { holdReason: async () => null, assertActive: async () => undefined } as never,
    );
    await service.run(ASSET as never);
    // RETRY on seq 1 holds this payer's later seqs for the pass, as ever.
    expect(calls.map((call) => [call.payer, call.seq])).toEqual([[HONEST, '1']]);
  });

  it('the write-off sweep keeps a debt without a delegate once some wallet is blocked', async () => {
    // NULL poisoning: `NULL = ANY(non-empty)` is NULL, and `NOT (… OR NULL)` dropped the row.
    const debtor = `${CHAIN}:0x7777777777777777777777777777777777777777`;
    await seed(debtor, 1);
    await dataSource.query(
      `UPDATE payment_intents SET redemption_lapsed_at = now() - interval '40 days'
        WHERE agent_account = $1`,
      [debtor],
    );
    const due = await payments.findDueForWriteOff(new Date(), 500, {
      organizationIds: [],
      walletKeys: ['eip155:0x0000000000000000000000000000000000000abc'],
      chainAccounts: [BLOCKED.toLowerCase()],
    });
    expect(due.map((row) => (row as { agentAccount?: string }).agentAccount)).toContain(debtor);
  });
});
