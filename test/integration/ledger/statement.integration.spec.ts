import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { BuyerEscrowRepository } from '@database/postgres/repositories/buyer-escrow.repository';
import { EscrowWithdrawalEventRepository } from '@database/postgres/repositories/escrow-withdrawal-event.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { EscrowWithdrawalEventKind } from '@database/postgres/entities/escrow-withdrawal-event.entity';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { EscrowBalanceReaderPort } from '@modules/ledger/ports/escrow-balance-reader.port';
import { StatementService } from '@modules/ledger/services/statement.service';
import { WithdrawalsService } from '@modules/ledger/services/withdrawals.service';
import { PaymentIntentStatus, PaymentRail } from '@modules/payment/ports/payment.types';
import { MoneyUtil } from '@shared/utils/money.util';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

/**
 * The statement's money half (B7) against real Postgres: opening + deposits −
 * withdrawals − paid = closing, from recorded deposits, indexed claims and
 * charged rail-B calls, and the closing balance checked against the escrow
 * read now. It writes nothing.
 */
const DATABASE = 'assay_statement_balance_test';
const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const ASSET = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const ADDRESS = '0x66d7CA4cD09C65197B2f3239c1fe79631747dd00';
const ACCOUNT = `${CHAIN}:${ADDRESS}`;
const SEPT = new Date('2026-09-01T00:00:00Z');
const OCT = new Date('2026-10-01T00:00:00Z');
const NOV = new Date('2026-11-01T00:00:00Z');
const NOW = new Date('2026-10-19T12:00:00Z');

describe('GET /statements/balance, against a real database', () => {
  let dataSource: DataSource;
  let statements: StatementService;
  let chainBalance: bigint;
  const org = randomUUID();

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    await dataSource.query(`ALTER TABLE payment_intents DISABLE TRIGGER ALL`);
    await dataSource.query(`ALTER TABLE payment_intents ENABLE TRIGGER USER`);
    await dataSource.query(
      `INSERT INTO "buyer_escrows"
         ("organization_id", "account_id", "asset_id", "escrow_account_id", "escrow_asset_account_id", "next_seq")
       VALUES ($1, $2, $3, $4, $4, 1)`,
      [org, ACCOUNT, ASSET, `${CHAIN}:0x60aBdb81796322b1bA6674068a3861309a9f8D37`],
    );
    const events = new EscrowWithdrawalEventRepository(dataSource);
    const reader = {
      read: async () => ({
        balance: MoneyUtil.of(chainBalance, ASSET, 6),
        observedAt: NOW,
      }),
    } as unknown as EscrowBalanceReaderPort;
    statements = new StatementService(
      new WithdrawalsService(new BuyerEscrowRepository(dataSource), events),
      new LedgerEntryRepository(dataSource),
      new PaymentIntentRepository(dataSource),
      events,
      reader,
    );

    // September: deposit 20, paid 1. October: deposit 5 then a reorg drops it,
    // deposit 10, withdraw 3 (of 4 asked), paid 2 + 0.5 (not redeemed yet);
    // an owed call and a forfeited one are not paid.
    await deposit('DEPOSIT_PENDING', 20_000_000n, '2026-09-02T00:00:00Z');
    await deposit('DEPOSIT_PENDING', 5_000_000n, '2026-10-02T00:00:00Z');
    await deposit('DEPOSIT_REJECT', 5_000_000n, '2026-10-02T00:20:00Z');
    await deposit('DEPOSIT_PENDING', 10_000_000n, '2026-10-03T00:00:00Z');
    await call(1_000_000n, '2026-09-10T00:00:00Z', { redeemed: true });
    await call(2_000_000n, '2026-10-05T00:00:00Z', { redeemed: true });
    await call(500_000n, '2026-10-18T00:00:00Z', { redeemed: false });
    await call(700_000n, '2026-10-18T01:00:00Z', { owed: true });
    await call(300_000n, '2026-10-18T02:00:00Z', { forfeited: true });
    await call(400_000n, '2026-10-18T03:00:00Z', { railA: true });
    await events.applyIndexedRange(CHAIN, 100n, [
      {
        chainId: CHAIN,
        buyerAddress: ADDRESS.toLowerCase(),
        kind: EscrowWithdrawalEventKind.WITHDRAWN,
        amount: 3_000_000n,
        requested: 4_000_000n,
        availableAt: null,
        blockNumber: 99n,
        logIndex: 0,
        transactionHash: `0x${'ab'.repeat(32)}`,
        blockTime: new Date('2026-10-10T00:00:00Z'),
      },
    ]);
  }, 300_000);
  afterAll(async () => dataSource?.destroy());

  async function deposit(type: string, amount: bigint, at: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO ledger_entries
         (organization_id, account_id, entry_type, amount, asset_id, decimals, created_at)
       VALUES ($1, $2, $3, $4, $5, 6, $6)`,
      [org, ACCOUNT, type, amount.toString(), ASSET, at],
    );
  }

  async function call(
    price: bigint,
    at: string,
    options: { redeemed?: boolean; owed?: boolean; forfeited?: boolean; railA?: boolean },
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO payment_intents (
         id, organization_id, status, agent_id, agent_account, provider_id, provider_account,
         tool_id, rail, call_id, call_class, asset_id, decimals, price_amount, provider_amount,
         platform_fee, request_hash, chain_id, expires_at, voucher_seq, voucher_signature,
         voucher_resource_hash, voucher_issued_at, hold_id, redemption_tx_refs,
         redemption_lapsed_at, redemption_last_error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PAID', $11, 6, $12, $12, 0,
               $13, $14, now(), $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        randomUUID(),
        org,
        PaymentIntentStatus.SETTLED,
        randomUUID(),
        ACCOUNT,
        randomUUID(),
        `${CHAIN}:0x5555555555555555555555555555555555555555`,
        randomUUID(),
        options.railA ? PaymentRail.RAIL_A_PER_CALL : PaymentRail.RAIL_B_VOUCHER,
        randomUUID(),
        ASSET,
        price.toString(),
        `sha256:${randomUUID().replace(/-/g, '').padEnd(64, '0')}`,
        CHAIN,
        options.railA ? null : String(Math.floor(Math.random() * 1e9)),
        options.railA ? null : `0x${'12'.repeat(65)}`,
        options.railA ? null : `sha256:${'cd'.repeat(32)}`,
        options.railA ? null : String(Math.floor(Date.now() / 1000)),
        randomUUID(),
        options.redeemed ? [`0x${'ef'.repeat(32)}`] : [],
        options.owed ? at : null,
        options.forfeited ? 'provider_forfeit:DelegateIsRevoked' : null,
        at,
      ],
    );
  }

  const amounts = (item: Record<string, unknown>) =>
    Object.fromEntries(
      ['opening', 'deposits', 'withdrawals', 'paid', 'closing'].map((key) => [
        key,
        (item[key] as { amount: string }).amount,
      ]),
    );

  it('adds up: opening + deposits − withdrawals − paid = closing', async () => {
    const october = await statements.balance(org, OCT, NOV, NOW);

    expect(october.items).toHaveLength(1);
    expect(october.items[0].account).toBe(ACCOUNT);
    expect(amounts(october.items[0] as never)).toEqual({
      opening: '19000000',
      deposits: '10000000',
      withdrawals: '3000000',
      paid: '2500000',
      closing: '23500000',
    });
  });

  it('chains months: September’s closing is October’s opening, and a past month is not checked', async () => {
    const september = await statements.balance(org, SEPT, OCT, NOW);

    expect(amounts(september.items[0] as never)).toEqual({
      opening: '0',
      deposits: '20000000',
      withdrawals: '0',
      paid: '1000000',
      closing: '19000000',
    });
    expect(september.items[0].check).toBeNull();
  });

  it('checks the current month against the escrow, allowing for payments still being settled', async () => {
    // The chain still holds the 0.50 not redeemed yet.
    chainBalance = 24_000_000n;
    const matched = (await statements.balance(org, OCT, NOV, NOW)).items[0].check!;
    expect(matched).toMatchObject({
      escrowBalance: { amount: '24000000' },
      stillSettling: { amount: '500000' },
      difference: { amount: '0' },
      matches: true,
    });

    chainBalance = 23_000_000n;
    const off = (await statements.balance(org, OCT, NOV, NOW)).items[0].check!;
    expect(off).toMatchObject({ difference: { amount: '-1000000' }, matches: false });
  });

  it('shows another organization nothing', async () => {
    expect((await statements.balance(randomUUID(), OCT, NOV, NOW)).items).toEqual([]);
  });
});
