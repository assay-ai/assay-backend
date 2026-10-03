import { LedgerErrorCode } from '@modules/ledger/errors/ledger.errors';
import {
  HoldResolution,
  LedgerEntryType,
  LedgerHoldStatus,
} from '@modules/ledger/ports/ledger.types';
import { BaseError } from '@shared/errors/base.error';
import {
  USDC_ASSET,
  LedgerTestContext,
  createLedgerTestContext,
} from '../helpers/ledger-test-context';

/** The code of a rejected `PromiseSettledResult`, asserting it is a `BaseError` on the way. */
function codeOf(result: PromiseSettledResult<unknown>): string {
  expect(result.status).toBe('rejected');
  const reason = (result as PromiseRejectedResult).reason;
  expect(reason).toBeInstanceOf(BaseError);
  return (reason as BaseError).errorCode;
}

describe('ledger holds under concurrency — the case the implementation is most likely to fail', () => {
  let context: LedgerTestContext;

  beforeAll(async () => {
    context = await createLedgerTestContext();
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  it('two concurrent createHold calls for the full balance: exactly one is fulfilled, exactly one rejects with LEDGER_INSUFFICIENT_AVAILABLE_BALANCE', async () => {
    const agent = context.account('agent-race-full');
    const N = 100n;
    await context.fund(agent, N);

    const results = await Promise.allSettled([
      context.ledger.createHold({
        organizationId: context.organizationId,
        accountId: agent,
        money: context.usdc(N),
        intentId: context.intent('intent-race-full-a'),
      }),
      context.ledger.createHold({
        organizationId: context.organizationId,
        accountId: agent,
        money: context.usdc(N),
        intentId: context.intent('intent-race-full-b'),
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(codeOf(rejected[0])).toBe(LedgerErrorCode.LEDGER_INSUFFICIENT_AVAILABLE_BALANCE);

    const balance = await context.ledger.getBalance(context.organizationId, agent, USDC_ASSET);
    expect(balance.available.amount).toBe('0');
    expect(balance.held.amount).toBe(N.toString());

    const journal = await context.ledger.readJournal(context.organizationId, { accountId: agent });
    expect(journal.filter((e) => e.entryType === LedgerEntryType.HOLD_CREATE)).toHaveLength(1);
  });

  it('K concurrent holds of 1 unit each against a balance of exactly K/2 lets exactly K/2 succeed', async () => {
    const K = 20;
    const agent = context.account('agent-race-k');
    await context.fund(agent, BigInt(K / 2));

    const results = await Promise.allSettled(
      Array.from({ length: K }, (_, i) =>
        context.ledger.createHold({
          organizationId: context.organizationId,
          accountId: agent,
          money: context.usdc(1n),
          intentId: context.intent(`intent-race-k-${i}`),
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(K / 2);
    expect(rejected).toHaveLength(K / 2);
    for (const result of rejected) {
      expect(codeOf(result)).toBe(LedgerErrorCode.LEDGER_INSUFFICIENT_AVAILABLE_BALANCE);
    }

    const balance = await context.ledger.getBalance(context.organizationId, agent, USDC_ASSET);
    expect(balance.available.amount).toBe('0');
    expect(balance.held.amount).toBe(String(K / 2));
  });

  it('a concurrent release and commit of the same open hold: exactly one applies, never both, and the balance matches whichever won', async () => {
    const agent = context.account('agent-race-resolve');
    await context.fund(agent, 100n);
    const hold = await context.ledger.createHold({
      organizationId: context.organizationId,
      accountId: agent,
      money: context.usdc(100n),
      intentId: context.intent('intent-race-resolve'),
    });

    const outcomes = await Promise.allSettled([
      context.ledger.releaseHold(context.organizationId, hold.id),
      context.ledger.commitHold(context.organizationId, hold.id),
    ]);

    // Requesting opposite terminal states means a fulfilled call here can
    // never be a no-op repeat of the other side's outcome — so at most one
    // of the two calls may report `applied === true`.
    const appliedCount = outcomes.filter(
      (o) => o.status === 'fulfilled' && (o.value as HoldResolution).applied,
    ).length;
    expect(appliedCount).toBe(1);

    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(codeOf(outcome)).toBe(LedgerErrorCode.LEDGER_HOLD_ALREADY_RESOLVED);
      }
    }

    const finalHold = await context.ledger.getHold(context.organizationId, hold.id);
    const balance = await context.ledger.getBalance(context.organizationId, agent, USDC_ASSET);

    if (finalHold.status === LedgerHoldStatus.RELEASED) {
      expect(balance.available.amount).toBe('100');
      expect(balance.held.amount).toBe('0');
    } else {
      expect(finalHold.status).toBe(LedgerHoldStatus.COMMITTED);
      expect(balance.available.amount).toBe('0');
      expect(balance.held.amount).toBe('0');
    }

    const journal = await context.ledger.readJournal(context.organizationId, { accountId: agent });
    const resolutionRows = journal.filter(
      (e) =>
        e.entryType === LedgerEntryType.HOLD_RELEASE || e.entryType === LedgerEntryType.HOLD_COMMIT,
    );
    expect(resolutionRows).toHaveLength(1);
  });

  it('8 concurrent releases of one open hold write exactly one HOLD_RELEASE journal row', async () => {
    const agent = context.account('agent-race-many-release');
    await context.fund(agent, 50n);
    const hold = await context.ledger.createHold({
      organizationId: context.organizationId,
      accountId: agent,
      money: context.usdc(50n),
      intentId: context.intent('intent-race-many-release'),
    });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => context.ledger.releaseHold(context.organizationId, hold.id)),
    );

    // Repeating a resolution is a no-op, not an error — every call must succeed.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const appliedCount = results.filter(
      (r) => r.status === 'fulfilled' && (r.value as HoldResolution).applied,
    ).length;
    expect(appliedCount).toBe(1);

    const journal = await context.ledger.readJournal(context.organizationId, { accountId: agent });
    expect(journal.filter((e) => e.entryType === LedgerEntryType.HOLD_RELEASE)).toHaveLength(1);
  });

  it('interleaved concurrent holds on two different accounts do not block or corrupt each other', async () => {
    const agentA = context.account('agent-race-two-a');
    const agentB = context.account('agent-race-two-b');
    await context.fund(agentA, 100n);
    await context.fund(agentB, 100n);

    const [holdA, holdB] = await Promise.all([
      context.ledger.createHold({
        organizationId: context.organizationId,
        accountId: agentA,
        money: context.usdc(100n),
        intentId: context.intent('intent-two-a'),
      }),
      context.ledger.createHold({
        organizationId: context.organizationId,
        accountId: agentB,
        money: context.usdc(100n),
        intentId: context.intent('intent-two-b'),
      }),
    ]);
    expect(holdA.status).toBe(LedgerHoldStatus.OPEN);
    expect(holdB.status).toBe(LedgerHoldStatus.OPEN);

    const balanceA = await context.ledger.getBalance(context.organizationId, agentA, USDC_ASSET);
    const balanceB = await context.ledger.getBalance(context.organizationId, agentB, USDC_ASSET);
    expect(balanceA.held.amount).toBe('100');
    expect(balanceA.available.amount).toBe('0');
    expect(balanceB.held.amount).toBe('100');
    expect(balanceB.available.amount).toBe('0');
  });

  it('the two-way full-balance race holds up over 15 repeated trials — a lock bug that loses one race in ten would pass a single-shot test', async () => {
    for (let i = 0; i < 15; i++) {
      await context.reset();
      const agent = context.account(`agent-race-loop-${i}`);
      await context.fund(agent, 10n);

      const results = await Promise.allSettled([
        context.ledger.createHold({
          organizationId: context.organizationId,
          accountId: agent,
          money: context.usdc(10n),
          intentId: context.intent(`intent-race-loop-a-${i}`),
        }),
        context.ledger.createHold({
          organizationId: context.organizationId,
          accountId: agent,
          money: context.usdc(10n),
          intentId: context.intent(`intent-race-loop-b-${i}`),
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(codeOf(rejected[0])).toBe(LedgerErrorCode.LEDGER_INSUFFICIENT_AVAILABLE_BALANCE);

      const balance = await context.ledger.getBalance(context.organizationId, agent, USDC_ASSET);
      expect(balance.available.amount).toBe('0');
      expect(balance.held.amount).toBe('10');
    }
  });
});
