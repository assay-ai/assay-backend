import { randomUUID } from 'node:crypto';

import { DepositFinalityResolution1758100000001 } from '@database/postgres/migrations/1758100000001-deposit-finality-resolution';
import { AccountId } from '@modules/chains/ports/caip.types';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { DEPOSIT_FINALITY_SWEEP_BATCH } from '@modules/payment/constants/deposit-intent.constants';

import {
  DepositTestContext,
  USDC_ASSET,
  createDepositTestContext,
  USDC_DECIMALS,
} from '../helpers/deposit-test-context';

const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const AMOUNT = 1_000_000n;

/**
 * The finality sweep's candidate window, exercised past its own batch size.
 *
 * `deposit-intent-lifecycle.integration.spec.ts` calls
 * `promotePendingDeposits(50)` against a table holding exactly one settled
 * intent, so its `ORDER BY updated_at ASC LIMIT n` is never exercised — and
 * `DepositTestContext.reset()` truncates `deposit_intents` between cases, so
 * the window can never accumulate across `it` blocks either. Everything here
 * therefore seeds inside a single `it`.
 *
 * The defect this guards: the sweep resolved deposits in the **ledger** and
 * never touched the `deposit_intents` row, and `updated_at` moves only on a
 * real `UPDATE`. So the oldest `DEPOSIT_FINALITY_SWEEP_BATCH` settled deposits
 * were a permanent prefix of the candidate list, and deposit number 201 was
 * never promoted — its money stayed in `pending`, spendable by nobody, with no
 * log line anywhere.
 */
describe('Deposit finality sweep — the candidate window past its batch size', () => {
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

  /** A `SETTLED` deposit with a `DEPOSIT_PENDING` entry, seeded without the chain path. */
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

    await ctx.ledger.appendNow({
      organizationId: ctx.organizationId,
      accountId: account,
      entryType: LedgerEntryType.DEPOSIT_PENDING,
      money: ctx.usdc(AMOUNT),
      intentId: id,
      chainTxRef: `Tx-${id}`,
    });

    return { id, account };
  }

  async function entryTypes(intentId: string): Promise<LedgerEntryType[]> {
    const journal = await ctx.ledger.readJournal(ctx.organizationId, { intentId });
    return journal.map((entry) => entry.entryType);
  }

  async function resolvedAt(intentId: string): Promise<Date | null> {
    const [row] = await ctx.dataSource.query<{ finality_resolved_at: Date | null }[]>(
      `SELECT "finality_resolved_at" FROM "deposit_intents" WHERE "id" = $1`,
      [intentId],
    );
    return row?.finality_resolved_at ?? null;
  }

  it('reaches a deposit settled after the batch is already full', async () => {
    (ctx.adapter.observeTransfer as jest.Mock).mockResolvedValue({
      amount: AMOUNT.toString(),
      asset: USDC_ASSET,
      decimals: USDC_DECIMALS,
    });

    // Exactly one batch of older deposits, plus the one that must not be lost
    // behind them. Seeded in one `it` on purpose — `reset()` truncates.
    const older: string[] = [];
    for (let index = 0; index < DEPOSIT_FINALITY_SWEEP_BATCH; index++) {
      const { id } = await seedSettledDeposit(`agent-window-old-${index}`);
      older.push(id);
    }
    const newest = await seedSettledDeposit('agent-window-newest');

    // `updated_at` decides the window, and 201 inserts can land inside one
    // clock tick. Back-date the batch explicitly so the ordering under test is
    // the ordering asserted, rather than whatever the tie-break happened to be.
    await ctx.dataSource.query(
      `UPDATE "deposit_intents" SET "updated_at" = now() - interval '1 hour' WHERE "id" <> $1`,
      [newest.id],
    );

    expect(await ctx.pending(newest.account)).toBe(AMOUNT);

    // Pass one fills its batch with the older deposits and promotes them. The
    // newest sorts last by `updated_at` and cannot be in this window.
    const first = await ctx.finality.promotePendingDeposits(DEPOSIT_FINALITY_SWEEP_BATCH);
    expect(first.checked).toBe(DEPOSIT_FINALITY_SWEEP_BATCH);
    expect(first.confirmed).toBe(DEPOSIT_FINALITY_SWEEP_BATCH);
    expect(await entryTypes(newest.id)).toEqual([LedgerEntryType.DEPOSIT_PENDING]);

    // Pass two is the whole point. Before the fix the same 200 rows came back
    // — resolved in the journal but still first by `updated_at` — the sweep
    // skipped all 200, and the newest deposit was never promoted by any pass.
    const second = await ctx.finality.promotePendingDeposits(DEPOSIT_FINALITY_SWEEP_BATCH);
    expect(second.checked).toBe(1);
    expect(second.confirmed).toBe(1);

    expect(await entryTypes(newest.id)).toEqual([
      LedgerEntryType.DEPOSIT_PENDING,
      LedgerEntryType.DEPOSIT_CONFIRM,
    ]);
    expect(await ctx.pending(newest.account)).toBe(0n);
    expect(await ctx.available(newest.account)).toBe(AMOUNT);

    // And the resolved batch has genuinely left the queue, rather than the
    // newest having merely jumped it.
    expect(await resolvedAt(older[0])).not.toBeNull();
    expect(await resolvedAt(newest.id)).not.toBeNull();

    const third = await ctx.finality.promotePendingDeposits(DEPOSIT_FINALITY_SWEEP_BATCH);
    expect(third.checked).toBe(0);
  });

  it('never writes a second DEPOSIT_CONFIRM, even with the queue marker cleared', async () => {
    (ctx.adapter.observeTransfer as jest.Mock).mockResolvedValue({
      amount: AMOUNT.toString(),
      asset: USDC_ASSET,
      decimals: USDC_DECIMALS,
    });

    const deposit = await seedSettledDeposit('agent-idempotent');

    expect((await ctx.finality.promotePendingDeposits(50)).confirmed).toBe(1);

    // An ordinary second pass: the marker keeps it out of the candidate list.
    const second = await ctx.finality.promotePendingDeposits(50);
    expect(second.checked).toBe(0);

    // Now take the marker away. The journal check — not the column — is what
    // makes double-crediting impossible, and this is what proves the column
    // did not quietly become the only guard. Nothing in the database would
    // stop a second credit: `uq_ledger_entries_intent_credit_type` is partial
    // on `PROVIDER_CREDIT` / `PLATFORM_FEE` and does not cover deposits.
    await ctx.dataSource.query(
      `UPDATE "deposit_intents" SET "finality_resolved_at" = NULL WHERE "id" = $1`,
      [deposit.id],
    );

    const third = await ctx.finality.promotePendingDeposits(50);
    expect(third.checked).toBe(1);
    expect(third.confirmed).toBe(0);
    expect(third.skipped).toBe(1);

    expect(await entryTypes(deposit.id)).toEqual([
      LedgerEntryType.DEPOSIT_PENDING,
      LedgerEntryType.DEPOSIT_CONFIRM,
    ]);
    expect(await ctx.available(deposit.account)).toBe(AMOUNT);

    // The skip re-stamped it, so a lost write cannot rebuild the prefix.
    expect(await resolvedAt(deposit.id)).not.toBeNull();
  });

  it('leaves a settled deposit whose DEPOSIT_PENDING has not landed yet in the queue', async () => {
    (ctx.adapter.observeTransfer as jest.Mock).mockResolvedValue({
      amount: AMOUNT.toString(),
      asset: USDC_ASSET,
      decimals: USDC_DECIMALS,
    });

    // The row is SETTLED but its pending entry has not landed — the window
    // between the status update and the ledger write in
    // `DepositService.settleDeposit`. Stamping here would be the original bug
    // with a new cause.
    const id = randomUUID();
    await ctx.repository.insert({
      id,
      organizationId: ctx.organizationId,
      status: 'SETTLED',
      agentId: randomUUID(),
      agentAccount: ctx.account('agent-unflushed'),
      assetId: USDC_ASSET,
      decimals: USDC_DECIMALS,
      requestedAmount: AMOUNT.toString(),
      settledAmount: AMOUNT.toString(),
      chainId: SOLANA_DEVNET,
      chainTxRef: `Tx-${id}`,
      expiresAt: new Date(Date.now() + 90_000),
    });

    const report = await ctx.finality.promotePendingDeposits(50);
    expect(report.checked).toBe(1);
    expect(report.skipped).toBe(1);
    expect(await resolvedAt(id)).toBeNull();
  });

  it('the migration backfills a deposit that was resolved before the column existed', async () => {
    (ctx.adapter.observeTransfer as jest.Mock).mockResolvedValue({
      amount: AMOUNT.toString(),
      asset: USDC_ASSET,
      decimals: USDC_DECIMALS,
    });

    const deposit = await seedSettledDeposit('agent-backfill');
    expect((await ctx.finality.promotePendingDeposits(50)).confirmed).toBe(1);

    // Rewind to the pre-migration shape: dropping the column takes its partial
    // index with it, which is exactly the state a deployment upgrades from.
    await ctx.dataSource.query(`ALTER TABLE "deposit_intents" DROP COLUMN "finality_resolved_at"`);

    const runner = ctx.dataSource.createQueryRunner();
    try {
      await runner.connect();
      await new DepositFinalityResolution1758100000001().up(runner);
    } finally {
      await runner.release();
    }

    const stamped = await resolvedAt(deposit.id);
    expect(stamped).not.toBeNull();

    // Stamped from the resolving entry itself, not from `now()`.
    const [entry] = await ctx.dataSource.query<{ created_at: Date }[]>(
      `SELECT "created_at" FROM "ledger_entries"
        WHERE "intent_id" = $1 AND "entry_type" = 'DEPOSIT_CONFIRM'`,
      [deposit.id],
    );
    expect(new Date(stamped as Date).toISOString()).toBe(new Date(entry.created_at).toISOString());

    // And the backfilled row is out of the queue on the first post-deploy pass.
    expect((await ctx.finality.promotePendingDeposits(50)).checked).toBe(0);
  });
});
