import { randomUUID } from 'node:crypto';

import { DepositFinalityService } from '@modules/payment/services/deposit-finality.service';
import { AccountId } from '@modules/chains/ports/caip.types';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';

import {
  DepositTestContext,
  USDC_ASSET,
  USDC_DECIMALS,
  createDepositTestContext,
} from '../helpers/deposit-test-context';

const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const AMOUNT = 1_000_000n;

/**
 * `uq_ledger_entries_deposit_resolution` — the guard that makes a second
 * trigger on the deposit path safe.
 *
 * ## Why this is an integration test and could not be a unit test
 *
 * The thing under test is a database constraint. A unit suite running over
 * in-memory fakes would pass against the *unfixed* code, because a fake has no
 * unique index — that is exactly how `rail-a-hold-never-commits` survived 2900
 * green tests. So the race is run against real Postgres, and the assertion is
 * on rows the database actually holds.
 *
 * ## Why two service instances rather than two calls on one
 *
 * `DepositFinalityService` serialises its own sweeps, so two calls on one
 * instance can never overlap. That in-process lock is real and worth having,
 * but it is scoped to a process — and the whole reason the constraint exists is
 * that the API, the scheduler's cron and the Helius watcher are not guaranteed
 * to be one process forever. Two instances sharing one database is the shape
 * the index is defending, so that is the shape exercised here.
 */
describe('Deposit resolution uniqueness — one credit per signature', () => {
  let ctx: DepositTestContext;

  beforeAll(async () => {
    ctx = await createDepositTestContext();
  });

  afterEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function seedSettledDeposit(label: string): Promise<{ id: string; account: AccountId }> {
    const id = randomUUID();
    const account = ctx.account(label);

    await ctx.repository.insert({
      id,
      organizationId: ctx.organizationId,
      status: 'SETTLED',
      statusReason: 'settlement observed on-chain',
      agentId: randomUUID(),
      agentAccount: account,
      assetId: USDC_ASSET,
      decimals: USDC_DECIMALS,
      requestedAmount: AMOUNT.toString(),
      settledAmount: AMOUNT.toString(),
      chainId: SOLANA_DEVNET,
      chainTxRef: `Tx-${id}`,
      expiresAt: new Date(Date.now() + 90_000),
    });

    ctx.ledger.append({
      organizationId: ctx.organizationId,
      accountId: account,
      entryType: LedgerEntryType.DEPOSIT_PENDING,
      money: ctx.usdc(AMOUNT),
      intentId: id,
      chainTxRef: `Tx-${id}`,
    });
    await ctx.ledger.flush();

    return { id, account };
  }

  it('refuses a second DEPOSIT_CONFIRM for one signature at the schema level', async () => {
    // Two intents on one account, so both credits have pending to consume and
    // the balance-fold guard cannot be what refuses the second write.
    const first = await seedSettledDeposit('agent-uq-direct');
    const second = await seedSettledDeposit('agent-uq-direct');
    const signature = `Tx-${first.id}`;

    await ctx.ledger.appendNow({
      organizationId: ctx.organizationId,
      accountId: first.account,
      entryType: LedgerEntryType.DEPOSIT_CONFIRM,
      money: ctx.usdc(AMOUNT),
      intentId: first.id,
      chainTxRef: signature,
    });

    // A different intent, the same transfer. The narrower key
    // `(organization_id, intent_id, entry_type)` would allow this; keying on
    // the signature is what refuses it.
    await expect(
      ctx.ledger.appendNow({
        organizationId: ctx.organizationId,
        accountId: second.account,
        entryType: LedgerEntryType.DEPOSIT_CONFIRM,
        money: ctx.usdc(AMOUNT),
        intentId: second.id,
        chainTxRef: signature,
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('still allows the DEPOSIT_PENDING that shares the signature', async () => {
    // The predicate is load-bearing: settle writes the pending entry with the
    // same `chain_tx_ref` the confirm will carry, so an index over the bare
    // column would refuse the credit on account of its own precursor.
    const { id, account } = await seedSettledDeposit('agent-uq-pending');

    await expect(
      ctx.ledger.appendNow({
        organizationId: ctx.organizationId,
        accountId: account,
        entryType: LedgerEntryType.DEPOSIT_CONFIRM,
        money: ctx.usdc(AMOUNT),
        intentId: id,
        chainTxRef: `Tx-${id}`,
      }),
    ).resolves.toBeDefined();
  });

  it('credits once when two independent sweeps race the same deposit', async () => {
    const { id, account } = await seedSettledDeposit('agent-uq-race');
    expect(await ctx.pending(account)).toBe(AMOUNT);

    // A barrier, not a `Promise.all`. Left to timing these two sweeps simply
    // do not overlap — an earlier draft of this test passed against the
    // unfixed schema, which is worse than no test. `observeTransfer` is the
    // last await each sweep takes *after* its journal guard and *before* its
    // write, so holding both there until both arrive is what puts them
    // genuinely inside the window the constraint exists to close.
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = 0;

    (ctx.adapter.observeTransfer as jest.Mock).mockImplementation(async () => {
      arrived += 1;
      if (arrived === 2) release();
      await bothArrived;
      return { amount: AMOUNT.toString(), asset: USDC_ASSET, decimals: USDC_DECIMALS };
    });

    // A second process: same database, its own in-process lock.
    const second = new DepositFinalityService(
      ctx.repository,
      { resolve: () => ctx.adapter } as never,
      ctx.escrowReader,
      ctx.ledger,
    );

    const [a, b] = await Promise.allSettled([
      ctx.finality.promotePendingDeposits(50),
      second.promotePendingDeposits(50),
    ]);

    // Proof the interleaving actually happened — without this the assertions
    // below can be satisfied by two sweeps that never overlapped at all.
    expect(arrived).toBe(2);

    // Neither sweep may crash: a lost race is an ordinary outcome, not a fault.
    expect([a.status, b.status]).toEqual(['fulfilled', 'fulfilled']);

    const journal = await ctx.ledger.readJournal(ctx.organizationId, { intentId: id });
    const confirms = journal.filter((entry) => entry.entryType === LedgerEntryType.DEPOSIT_CONFIRM);
    expect(confirms).toHaveLength(1);

    // The claim that actually matters: the buyer was paid once.
    expect(await ctx.available(account)).toBe(AMOUNT);
    expect(await ctx.pending(account)).toBe(0n);
  });
});
