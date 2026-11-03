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
});
