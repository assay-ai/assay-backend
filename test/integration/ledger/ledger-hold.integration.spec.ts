import { LedgerErrorCode } from '@modules/ledger/errors/ledger.errors';
import { LedgerEntryType, LedgerHoldStatus } from '@modules/ledger/ports/ledger.types';
import { expectErrorCodeAsync } from '../../unit/helpers/expect-error-code';
import {
  USDC_ASSET,
  LedgerTestContext,
  createLedgerTestContext,
} from '../helpers/ledger-test-context';

describe('ledger holds — the four stated invariants', () => {
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

  it('releasing the same hold twice is idempotent: the second call reports applied=false, the balance is identical, and exactly one HOLD_RELEASE row exists', async () => {
    const agent = context.account('agent-release-twice');
    await context.fund(agent, 1_000n);

    const hold = await context.ledger.createHold({
      organizationId: context.organizationId,
      accountId: agent,
      money: context.usdc(400n),
      intentId: context.intent('intent-release-twice'),
    });

    const first = await context.ledger.releaseHold(context.organizationId, hold.id);
    expect(first.applied).toBe(true);
    const balanceAfterFirst = await context.ledger.getBalance(
      context.organizationId,
      agent,
      USDC_ASSET,
    );

    const second = await context.ledger.releaseHold(context.organizationId, hold.id);
    expect(second.applied).toBe(false);

    // The balance that happens to be right can still sit on a duplicated
    // entry — assert the row count, not just the balance.
    const balanceAfterSecond = await context.ledger.getBalance(
      context.organizationId,
      agent,
      USDC_ASSET,
    );
    expect(balanceAfterSecond).toEqual(balanceAfterFirst);

    const journal = await context.ledger.readJournal(context.organizationId, {
      accountId: agent,
      intentId: context.intent('intent-release-twice'),
    });
    expect(
      journal.filter((entry) => entry.entryType === LedgerEntryType.HOLD_RELEASE),
    ).toHaveLength(1);
  });

  it('commitHold after releaseHold rejects with LEDGER_HOLD_ALREADY_RESOLVED and writes no journal entry', async () => {
    const agent = context.account('agent-commit-after-release');
    await context.fund(agent, 1_000n);

    const hold = await context.ledger.createHold({
      organizationId: context.organizationId,
      accountId: agent,
      money: context.usdc(300n),
      intentId: context.intent('intent-commit-after-release'),
    });
    await context.ledger.releaseHold(context.organizationId, hold.id);

    const journalBefore = await context.ledger.readJournal(context.organizationId, {
      accountId: agent,
    });

    await expectErrorCodeAsync(
      () => context.ledger.commitHold(context.organizationId, hold.id),
      LedgerErrorCode.LEDGER_HOLD_ALREADY_RESOLVED,
    );

    const journalAfter = await context.ledger.readJournal(context.organizationId, {
      accountId: agent,
    });
    expect(journalAfter).toHaveLength(journalBefore.length);
  });

  it('the mirror case: releaseHold after commitHold also rejects with LEDGER_HOLD_ALREADY_RESOLVED', async () => {
    const agent = context.account('agent-release-after-commit');
    await context.fund(agent, 1_000n);

    const hold = await context.ledger.createHold({
      organizationId: context.organizationId,
      accountId: agent,
      money: context.usdc(300n),
      intentId: context.intent('intent-release-after-commit'),
    });
    await context.ledger.commitHold(context.organizationId, hold.id);

    const journalBefore = await context.ledger.readJournal(context.organizationId, {
      accountId: agent,
    });

    await expectErrorCodeAsync(
      () => context.ledger.releaseHold(context.organizationId, hold.id),
      LedgerErrorCode.LEDGER_HOLD_ALREADY_RESOLVED,
    );

    const journalAfter = await context.ledger.readJournal(context.organizationId, {
      accountId: agent,
    });
    expect(journalAfter).toHaveLength(journalBefore.length);
  });

  it('createHold for more than available rejects with LEDGER_INSUFFICIENT_AVAILABLE_BALANCE, writes no entry, and leaves the balance untouched', async () => {
    const agent = context.account('agent-over-hold');
    await context.fund(agent, 500n);

    const balanceBefore = await context.ledger.getBalance(
      context.organizationId,
      agent,
      USDC_ASSET,
    );
    const journalBefore = await context.ledger.readJournal(context.organizationId, {
      accountId: agent,
    });

    await expectErrorCodeAsync(
      () =>
        context.ledger.createHold({
          organizationId: context.organizationId,
          accountId: agent,
          money: context.usdc(501n),
          intentId: context.intent('intent-over-hold'),
        }),
      LedgerErrorCode.LEDGER_INSUFFICIENT_AVAILABLE_BALANCE,
    );

    const balanceAfter = await context.ledger.getBalance(context.organizationId, agent, USDC_ASSET);
    expect(balanceAfter).toEqual(balanceBefore);

    const journalAfter = await context.ledger.readJournal(context.organizationId, {
      accountId: agent,
    });
    expect(journalAfter).toHaveLength(journalBefore.length);
  });

  it('a hold of exactly the available balance succeeds, and a second hold of just 1 more unit fails — held funds are not available', async () => {
    const agent = context.account('agent-exact-then-one-more');
    await context.fund(agent, 250n);

    const hold = await context.ledger.createHold({
      organizationId: context.organizationId,
      accountId: agent,
      money: context.usdc(250n),
      intentId: context.intent('intent-exact'),
    });
    expect(hold.status).toBe(LedgerHoldStatus.OPEN);

    const balance = await context.ledger.getBalance(context.organizationId, agent, USDC_ASSET);
    expect(balance.available.amount).toBe('0');
    expect(balance.held.amount).toBe('250');

    await expectErrorCodeAsync(
      () =>
        context.ledger.createHold({
          organizationId: context.organizationId,
          accountId: agent,
          money: context.usdc(1n),
          intentId: context.intent('intent-exact-second'),
        }),
      LedgerErrorCode.LEDGER_INSUFFICIENT_AVAILABLE_BALANCE,
    );
  });
});
