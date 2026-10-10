import { randomUUID } from 'node:crypto';

import { DepositIntentEntity } from '@database/postgres/entities/deposit-intent.entity';
import { DepositIntentStatus } from '@modules/payment/ports/deposit.types';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';

import {
  DepositTestContext,
  USDC_ASSET,
  createDepositTestContext,
} from '../helpers/deposit-test-context';

/**
 * A distinct signature per test *run*, not merely per case.
 *
 * This was one shared constant, and `uq_ledger_entries_deposit_resolution`
 * refused to build over the rows it left behind — 71 `DEPOSIT_CONFIRM` and 71
 * `DEPOSIT_REJECT` all claiming the same transfer. The fixture was the thing
 * that was wrong: two deposits cannot share a Solana signature, so a harness in
 * which they do was modelling a state the chain cannot produce, and hiding the
 * one the index exists to refuse.
 *
 * Random rather than derived from the test name, because `ledger_entries` is
 * append-only and this file never truncates it: a value stable across runs
 * would collide with *yesterday's* rows on the second run.
 */
let txSig: string;

describe('Deposit intent lifecycle — real Postgres, real ledger, faked chain', () => {
  let ctx: DepositTestContext;

  beforeAll(async () => {
    ctx = await createDepositTestContext();
  });

  beforeEach(() => {
    txSig = `FakeDevnetTx-${randomUUID()}`.padEnd(74, '1');
  });

  afterEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('creates, settles and credits the ledger for exactly the observed amount', async () => {
    const agent = ctx.account('agent-lifecycle');
    const requested = ctx.usdc(1_000_000n);

    (ctx.adapter.observeTransfer as jest.Mock).mockResolvedValue({
      amount: '1000000',
      asset: USDC_ASSET,
      decimals: 6,
    });
    (ctx.adapter.extractSettledAmount as jest.Mock).mockReturnValue(requested);
    (ctx.facilitator.settle as jest.Mock).mockResolvedValue({
      success: true,
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      transaction: txSig,
    });

    const { intent } = await ctx.depositService.createDeposit({
      organizationId: ctx.organizationId,
      agentId: ctx.id('agent-lifecycle'),
      agentAccount: agent,
      chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as never,
      amount: requested,
    });

    expect(intent.status).toBe(DepositIntentStatus.CREATED);

    const settled = await ctx.depositService.settleDeposit(ctx.organizationId, intent.id, {
      x402Version: 2,
      scheme: 'exact',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as never,
      payload: { transaction: 'ZmFrZQ==' },
    });

    expect(settled.status).toBe(DepositIntentStatus.SETTLED);
    expect(settled.chainTxRef).toBe(txSig);

    await ctx.ledger.flush();
    expect(await ctx.pending(agent)).toBe(1_000_000n);
    expect(await ctx.available(agent)).toBe(0n);

    const journal = await ctx.ledger.readJournal(ctx.organizationId, { intentId: intent.id });
    expect(journal).toHaveLength(1);
    expect(journal[0].entryType).toBe(LedgerEntryType.DEPOSIT_PENDING);
    expect(journal[0].chainTxRef).toBe(txSig);
  });

  it('the expiry sweep moves an unfunded, overdue intent to EXPIRED and touches nothing else', async () => {
    const agent = ctx.account('agent-expiry');
    const { intent } = await ctx.depositService.createDeposit({
      organizationId: ctx.organizationId,
      agentId: ctx.id('agent-expiry'),
      agentAccount: agent,
      chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as never,
      amount: ctx.usdc(1_000_000n),
    });

    // Back-date it directly — there is no public API for creating an
    // already-expired intent, on purpose.
    await ctx.dataSource
      .createQueryBuilder()
      .update(DepositIntentEntity)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where('id = :id', { id: intent.id })
      .execute();

    const report = await ctx.expiry.sweep();
    expect(report.expired).toBeGreaterThanOrEqual(1);

    const after = await ctx.deposits.findById(ctx.organizationId, intent.id);
    expect(after.status).toBe(DepositIntentStatus.EXPIRED);
    expect(await ctx.pending(agent)).toBe(0n);
  });

  it('the finality sweep promotes a still-observable transaction to DEPOSIT_CONFIRM', async () => {
    const agent = ctx.account('agent-finality-confirm');
    const requested = ctx.usdc(2_000_000n);

    (ctx.adapter.observeTransfer as jest.Mock).mockResolvedValue({
      amount: '2000000',
      asset: USDC_ASSET,
      decimals: 6,
    });
    (ctx.adapter.extractSettledAmount as jest.Mock).mockReturnValue(requested);
    (ctx.facilitator.settle as jest.Mock).mockResolvedValue({
      success: true,
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      transaction: txSig,
    });

    const { intent } = await ctx.depositService.createDeposit({
      organizationId: ctx.organizationId,
      agentId: ctx.id('agent-finality-confirm'),
      agentAccount: agent,
      chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as never,
      amount: requested,
    });
    await ctx.depositService.settleDeposit(ctx.organizationId, intent.id, {
      x402Version: 2,
      scheme: 'exact',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as never,
      payload: { transaction: 'ZmFrZQ==' },
    });
    await ctx.ledger.flush();
    expect(await ctx.pending(agent)).toBe(2_000_000n);

    // Still there at `finalized` commitment — same mock, simulating no reorg.
    const report = await ctx.finality.promotePendingDeposits(50);
    expect(report.confirmed).toBeGreaterThanOrEqual(1);

    expect(await ctx.pending(agent)).toBe(0n);
    expect(await ctx.available(agent)).toBe(2_000_000n);

    const journal = await ctx.ledger.readJournal(ctx.organizationId, { intentId: intent.id });
    expect(journal.map((entry) => entry.entryType)).toEqual([
      LedgerEntryType.DEPOSIT_PENDING,
      LedgerEntryType.DEPOSIT_CONFIRM,
    ]);
  });

  it('the finality sweep writes DEPOSIT_REJECT when the transaction is no longer observable at finalized commitment', async () => {
    const agent = ctx.account('agent-finality-reject');
    const requested = ctx.usdc(500_000n);

    (ctx.adapter.observeTransfer as jest.Mock).mockResolvedValueOnce({
      amount: '500000',
      asset: USDC_ASSET,
      decimals: 6,
    });
    (ctx.adapter.extractSettledAmount as jest.Mock).mockReturnValue(requested);
    (ctx.facilitator.settle as jest.Mock).mockResolvedValue({
      success: true,
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      transaction: txSig,
    });

    const { intent } = await ctx.depositService.createDeposit({
      organizationId: ctx.organizationId,
      agentId: ctx.id('agent-finality-reject'),
      agentAccount: agent,
      chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as never,
      amount: requested,
    });
    await ctx.depositService.settleDeposit(ctx.organizationId, intent.id, {
      x402Version: 2,
      scheme: 'exact',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as never,
      payload: { transaction: 'ZmFrZQ==' },
    });
    await ctx.ledger.flush();
    expect(await ctx.pending(agent)).toBe(500_000n);

    // A reorg dropped it — the re-check finds nothing at `finalized` commitment, nor at the
    // default one. `null` at `finalized` alone only means "not final yet" and stays queued.
    (ctx.adapter.observeTransfer as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const report = await ctx.finality.promotePendingDeposits(50);
    expect(report.rejected).toBeGreaterThanOrEqual(1);

    expect(await ctx.pending(agent)).toBe(0n);
    expect(await ctx.available(agent)).toBe(0n);

    const journal = await ctx.ledger.readJournal(ctx.organizationId, { intentId: intent.id });
    expect(journal.map((entry) => entry.entryType)).toEqual([
      LedgerEntryType.DEPOSIT_PENDING,
      LedgerEntryType.DEPOSIT_REJECT,
    ]);
  });
});
