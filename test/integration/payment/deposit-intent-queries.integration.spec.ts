import { randomUUID } from 'node:crypto';

import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { DepositIntentStatus } from '@modules/payment/ports/deposit.types';

import { DepositTestContext, createDepositTestContext } from '../helpers/deposit-test-context';

/**
 * The deposit-intent SQL the unit fakes stand in for: the claim lookup (and
 * that each arm can use an index), the broadcast time bound, the open-intent
 * cap and the stuck-SETTLING queue.
 */
describe('Deposit intent queries — real Postgres', () => {
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

  /** `ledger_entries` is append-only and never truncated: a fresh account per case. */
  const freshAccount = () => ctx.account(`acct-${randomUUID()}`);
  const freshHash = () => `0x${randomUUID().replace(/-/g, '')}${'0'.repeat(32)}`;

  async function intent(
    account: ReturnType<DepositTestContext['account']>,
    status: DepositIntentStatus,
    ageMs: number,
    agent = 'agent-q',
  ) {
    const created = await ctx.deposits.create({
      organizationId: ctx.organizationId,
      agentId: ctx.id(agent),
      agentAccount: account,
      requestedAmount: ctx.usdc(5_000_000n),
      chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as never,
    });
    const createdAt = new Date(Date.now() - ageMs);
    await ctx.dataSource.query(
      `UPDATE "deposit_intents"
          SET "status" = $2, "created_at" = $3, "updated_at" = $3, "expires_at" = $4
        WHERE "id" = $1`,
      [created.id, status, createdAt, new Date(createdAt.getTime() + 90_000)],
    );
    return created.id;
  }

  it('findClaimOfTxRef finds a pending credit and a legacy DEPOSIT, per (hash, account)', async () => {
    const buyer = freshAccount();
    const other = freshAccount();
    const pendingHash = freshHash();
    const legacyHash = freshHash();
    for (const [entryType, hash] of [
      [LedgerEntryType.DEPOSIT_PENDING, pendingHash],
      [LedgerEntryType.DEPOSIT, legacyHash],
    ] as const) {
      await ctx.ledger.appendNow({
        organizationId: ctx.organizationId,
        accountId: buyer,
        entryType,
        money: ctx.usdc(1_000_000n),
        chainTxRef: hash,
      });
    }

    await expect(ctx.repository.findClaimOfTxRef(pendingHash, buyer)).resolves.toEqual({
      intentId: null,
    });
    await expect(ctx.repository.findClaimOfTxRef(legacyHash, buyer)).resolves.toEqual({
      intentId: null,
    });
    await expect(ctx.repository.findClaimOfTxRef(pendingHash, other)).resolves.toBeNull();
  });

  it('each ledger arm of the claim lookup can be served by an index', async () => {
    const runner = ctx.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      await runner.query('SET LOCAL enable_seqscan = off');
      for (const [entryType, index] of [
        ['DEPOSIT_PENDING', 'uq_ledger_entries_deposit_pending_account'],
        ['DEPOSIT', 'idx_ledger_entries_deposit_legacy_account'],
      ]) {
        const plan = (await runner.query(
          `EXPLAIN SELECT "intent_id" FROM "ledger_entries"
            WHERE "chain_tx_ref" = '0xab' AND "account_id" = 'a'
              AND "entry_type" = '${entryType}' AND "chain_tx_ref" IS NOT NULL LIMIT 1`,
        )) as { 'QUERY PLAN': string }[];
        expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(index);
      }
      await runner.rollbackTransaction();
    } finally {
      await runner.release();
    }
  });

  it('earliestUnsettledCreatedAt anchors on CREATED/EXPIRED/FAILED within the window only', async () => {
    const buyer = freshAccount();
    await intent(buyer, DepositIntentStatus.SETTLED, 60 * 60 * 1000);
    await intent(buyer, DepositIntentStatus.EXPIRED, 25 * 60 * 60 * 1000);
    await intent(buyer, DepositIntentStatus.FAILED, 30 * 60 * 1000);
    await intent(buyer, DepositIntentStatus.EXPIRED, 20 * 60 * 1000);
    await intent(buyer, DepositIntentStatus.CREATED, 0);
    await intent(freshAccount(), DepositIntentStatus.EXPIRED, 2 * 60 * 60 * 1000);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const earliest = await ctx.repository.earliestUnsettledCreatedAt(buyer, since);

    expect(earliest).not.toBeNull();
    expect(Math.abs(Date.now() - 30 * 60 * 1000 - earliest!.getTime())).toBeLessThan(10_000);
    await expect(
      ctx.repository.earliestUnsettledCreatedAt(freshAccount(), since),
    ).resolves.toBeNull();
  });

  it('countOpenForAgent counts CREATED and SETTLING inside their lifetime only', async () => {
    const buyer = freshAccount();
    await intent(buyer, DepositIntentStatus.CREATED, 0);
    await intent(buyer, DepositIntentStatus.SETTLING, 0);
    await intent(buyer, DepositIntentStatus.SETTLING, 10 * 60 * 1000);
    await intent(buyer, DepositIntentStatus.CREATED, 10 * 60 * 1000);
    await intent(buyer, DepositIntentStatus.SETTLED, 0);

    await expect(
      ctx.repository.countOpenForAgent(ctx.organizationId, ctx.id('agent-q'), new Date()),
    ).resolves.toBe(2);
  });

  it('findStaleSettling returns SETTLING rows untouched since the cut-off, oldest first', async () => {
    const buyer = freshAccount();
    const old = await intent(buyer, DepositIntentStatus.SETTLING, 10 * 60 * 1000);
    const older = await intent(buyer, DepositIntentStatus.SETTLING, 20 * 60 * 1000);
    await intent(buyer, DepositIntentStatus.SETTLING, 0);
    await intent(buyer, DepositIntentStatus.SETTLED, 20 * 60 * 1000);

    const stale = await ctx.repository.findStaleSettling(new Date(Date.now() - 2 * 60 * 1000), 10);

    expect(stale.map((row) => row.id)).toEqual([older, old]);

    await ctx.repository.recordSubmittedTx(ctx.organizationId, old, '0xfeed');
    const after = await ctx.repository.findOneBy({ organizationId: ctx.organizationId, id: old });
    expect(after?.submittedTxRef).toBe('0xfeed');
  });
  /** A SETTLED row in the finality queue, optionally already found uncovered. */
  async function settled(
    account: ReturnType<DepositTestContext['account']>,
    ageMs: number,
    marks: { uncoveredSince?: Date; nextCheckAt?: Date } = {},
  ) {
    const id = await intent(account, DepositIntentStatus.SETTLED, ageMs);
    await ctx.dataSource.query(
      `UPDATE "deposit_intents"
          SET "settled_amount" = 5000000, "chain_tx_ref" = $2,
              "finality_uncovered_since" = $3, "finality_next_check_at" = $4
        WHERE "id" = $1`,
      [id, freshHash(), marks.uncoveredSince ?? null, marks.nextCheckAt ?? null],
    );
    return id;
  }

  // H-1 (round 3): one buyer's uncovered rows never hold the head of the queue.
  it('findSettledAwaitingFinality skips backed-off rows and sorts uncovered rows last', async () => {
    const attacker = freshAccount();
    const honest = freshAccount();
    const now = Date.now();
    const due = [];
    for (let i = 0; i < 3; i += 1) {
      // Older than everything else, uncovered, due now.
      due.push(
        await settled(attacker, 60 * 60 * 1000 + i, {
          uncoveredSince: new Date(now - 60 * 60 * 1000),
          nextCheckAt: new Date(now - 1_000),
        }),
      );
    }
    const backedOff = await settled(attacker, 2 * 60 * 60 * 1000, {
      uncoveredSince: new Date(now - 60 * 60 * 1000),
      nextCheckAt: new Date(now + 5 * 60 * 1000),
    });
    const fresh = [await settled(honest, 2_000), await settled(honest, 1_000)];

    // A full batch of attacker rows cannot starve the honest buyer's deposits.
    const head = await ctx.repository.findSettledAwaitingFinality(2, new Date(now));
    expect(head.map((row) => row.id)).toEqual(fresh);
    expect(head.every((row) => row.uncoveredSince === null)).toBe(true);

    const all = await ctx.repository.findSettledAwaitingFinality(10, new Date(now));
    const ids = all.map((row) => row.id);
    expect(ids.slice(0, 2)).toEqual(fresh);
    expect(new Set(ids.slice(2))).toEqual(new Set(due));
    expect(ids).not.toContain(backedOff);
    expect(all[2].uncoveredSince).toBeInstanceOf(Date);

    // Due once its next check has passed.
    const later = await ctx.repository.findSettledAwaitingFinality(
      10,
      new Date(now + 6 * 60 * 1000),
    );
    expect(later.map((row) => row.id)).toContain(backedOff);
  });

  it('markFinalityUncovered takes the row out of the queue until its next check', async () => {
    const buyer = freshAccount();
    const id = await settled(buyer, 1_000);
    const now = Date.now();
    const since = new Date(now - 1_000);

    await expect(
      ctx.repository.markFinalityUncovered(ctx.organizationId, id, since, new Date(now + 30_000)),
    ).resolves.toBe(1);

    const ids = async (at: number) =>
      (await ctx.repository.findSettledAwaitingFinality(10, new Date(at))).map((row) => row.id);
    expect(await ids(now)).not.toContain(id);
    expect(await ids(now + 31_000)).toContain(id);
    const [row] = (
      await ctx.repository.findSettledAwaitingFinality(10, new Date(now + 31_000))
    ).filter((candidate) => candidate.id === id);
    expect(Math.abs(row.uncoveredSince!.getTime() - since.getTime())).toBeLessThan(5);

    // A resolved row is never re-marked.
    await ctx.repository.markFinalityResolved(ctx.organizationId, id, new Date());
    await expect(
      ctx.repository.markFinalityUncovered(ctx.organizationId, id, since, new Date(now)),
    ).resolves.toBe(0);
  });

  it('hasUncoveredPendingSince finds an unresolved uncovered deposit of this account only', async () => {
    const buyer = freshAccount();
    const now = Date.now();
    const id = await settled(buyer, 60 * 60 * 1000, {
      uncoveredSince: new Date(now - 20 * 60 * 1000),
    });
    const grace = new Date(now - 15 * 60 * 1000);

    await expect(ctx.repository.hasUncoveredPendingSince(buyer, grace)).resolves.toBe(true);
    await expect(
      ctx.repository.hasUncoveredPendingSince(buyer, new Date(now - 30 * 60 * 1000)),
    ).resolves.toBe(false);
    await expect(ctx.repository.hasUncoveredPendingSince(freshAccount(), grace)).resolves.toBe(
      false,
    );

    await ctx.repository.markFinalityResolved(ctx.organizationId, id, new Date());
    await expect(ctx.repository.hasUncoveredPendingSince(buyer, grace)).resolves.toBe(false);
  });

  it('findStaleSettling puts rows with a recorded transaction before rows without', async () => {
    const buyer = freshAccount();
    const noHashOldest = await intent(buyer, DepositIntentStatus.SETTLING, 3 * 60 * 60 * 1000);
    const hashed = await intent(buyer, DepositIntentStatus.SETTLING, 10 * 60 * 1000);
    await ctx.repository.recordSubmittedTx(ctx.organizationId, hashed, '0xfeed');
    await ctx.dataSource.query(
      `UPDATE "deposit_intents" SET "updated_at" = now() - interval '10 minutes' WHERE "id" = $1`,
      [hashed],
    );
    const cutoff = new Date(Date.now() - 2 * 60 * 1000);

    expect((await ctx.repository.findStaleSettling(cutoff, 1)).map((row) => row.id)).toEqual([
      hashed,
    ]);
    expect((await ctx.repository.findStaleSettling(cutoff, 10)).map((row) => row.id)).toEqual([
      hashed,
      noHashOldest,
    ]);
  });
});
