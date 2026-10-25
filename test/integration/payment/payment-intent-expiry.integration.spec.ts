import { LedgerEntryType, LedgerHoldStatus } from '@modules/ledger/ports/ledger.types';
import { PAYMENT_INTENT_EXPIRY_REASON } from '@modules/payment/constants/payment-intent.constants';
import { PaymentIntent, PaymentIntentStatus } from '@modules/payment/ports/payment.types';

import { PaymentTestContext, createPaymentTestContext } from '../helpers/payment-test-context';

const ONE_MINUTE_AGO = () => new Date(Date.now() - 60_000);
const IN_TEN_MINUTES = () => new Date(Date.now() + 10 * 60_000);

describe('payment intent expiry sweep — holds always expire in the agent’s favour', () => {
  let context: PaymentTestContext;

  beforeAll(async () => {
    context = await createPaymentTestContext();
  });

  afterAll(async () => {
    await context.close();
  });

  /**
   * The sweep is a platform-level job and deliberately spans organizations, so
   * intents left due by an earlier test — or an earlier run against this
   * database — are candidates for this test's pass too. Draining first makes
   * the counts in the report belong to the test that reads them.
   */
  beforeEach(async () => {
    await context.expiry.sweep();
    await context.reset();
  });

  /** A funded intent past its deadline, with the ledger hold really open. */
  async function overdueSecuredIntent(label: string): Promise<PaymentIntent> {
    const intent = await context.createIntent(label, { expiresAt: ONE_MINUTE_AGO() });
    await context.fund(intent.agentAccount, 5_000_000n);
    return context.intents.secureFunds(context.organizationId, intent.id);
  }

  it('releases the hold of an overdue FUNDS_SECURED intent and restores available', async () => {
    const secured = await overdueSecuredIntent('sweep-secured');
    expect(await context.available(secured.agentAccount)).toBe(4_000_000n);
    expect(await context.held(secured.agentAccount)).toBe(1_000_000n);

    const report = await context.expiry.sweep();

    expect(report).toMatchObject({ expired: 1, holdsReleased: 1, failed: 0 });

    const expired = await context.intents.findById(context.organizationId, secured.id);
    expect(expired.status).toBe(PaymentIntentStatus.EXPIRED);
    expect(expired.statusReason).toBe(PAYMENT_INTENT_EXPIRY_REASON);
    expect(expired.holdReleasedAt).not.toBeNull();

    // The money is genuinely back, in the ledger's own words.
    const hold = await context.ledger.getHold(context.organizationId, secured.holdId as string);
    expect(hold.status).toBe(LedgerHoldStatus.RELEASED);
    expect(await context.held(secured.agentAccount)).toBe(0n);
    expect(await context.available(secured.agentAccount)).toBe(5_000_000n);
  });

  it('writes a HOLD_RELEASE entry against the intent, so the release is auditable', async () => {
    const secured = await overdueSecuredIntent('sweep-journal');

    await context.expiry.sweep();

    const entries = await context.ledger.readJournal(context.organizationId, {
      intentId: secured.id,
    });

    expect(entries.map((entry) => entry.entryType)).toEqual([
      LedgerEntryType.HOLD_CREATE,
      LedgerEntryType.HOLD_RELEASE,
    ]);
    expect(entries[1].money.amount).toBe('1000000');
  });

  it('expires an overdue CREATED intent, which never reserved anything', async () => {
    const intent = await context.createIntent('sweep-created', { expiresAt: ONE_MINUTE_AGO() });

    const report = await context.expiry.sweep();

    expect(report).toMatchObject({ expired: 1, holdsReleased: 0, failed: 0 });

    const expired = await context.intents.findById(context.organizationId, intent.id);
    expect(expired.status).toBe(PaymentIntentStatus.EXPIRED);
    expect(expired.holdId).toBeNull();
    expect(expired.holdReleasedAt).toBeNull();
  });

  it('leaves an intent whose deadline has not passed alone', async () => {
    const intent = await context.createIntent('sweep-not-due', { expiresAt: IN_TEN_MINUTES() });
    await context.fund(intent.agentAccount, 5_000_000n);
    const secured = await context.intents.secureFunds(context.organizationId, intent.id);

    const report = await context.expiry.sweep();

    expect(report).toMatchObject({ expired: 0, holdsReleased: 0 });
    const after = await context.intents.findById(context.organizationId, intent.id);
    expect(after.status).toBe(PaymentIntentStatus.FUNDS_SECURED);
    expect(await context.held(secured.agentAccount)).toBe(1_000_000n);
  });

  /**
   * The disjoint-windows rule from the transition table, tested where it
   * matters: an overdue intent that is already in flight belongs to the
   * 24-hour hold backstop, not to this sweep.
   */
  it('will not expire an overdue PROVIDER_EXECUTING intent out from under its worker', async () => {
    const secured = await overdueSecuredIntent('sweep-in-flight');
    await context.intents.transition(
      context.organizationId,
      secured.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
    );

    const report = await context.expiry.sweep();

    expect(report).toMatchObject({ expired: 0, holdsReleased: 0, repaired: 0 });
    const after = await context.intents.findById(context.organizationId, secured.id);
    expect(after.status).toBe(PaymentIntentStatus.PROVIDER_EXECUTING);
    expect(await context.held(secured.agentAccount)).toBe(1_000_000n);
  });

  it('will not expire an overdue VERIFYING intent either', async () => {
    const secured = await overdueSecuredIntent('sweep-verifying');
    await context.intents.transition(
      context.organizationId,
      secured.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
    );
    await context.intents.transition(
      context.organizationId,
      secured.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VERIFYING,
    );

    const report = await context.expiry.sweep();

    expect(report).toMatchObject({ expired: 0, holdsReleased: 0 });
    const after = await context.intents.findById(context.organizationId, secured.id);
    expect(after.status).toBe(PaymentIntentStatus.VERIFYING);
  });

  /** Moves the intent's ledger hold past its own 24-hour deadline. */
  async function holdDeadlinePassed(intentId: string): Promise<void> {
    await context.dataSource.query(
      `UPDATE ledger_holds SET expires_at = now() - interval '1 minute' WHERE intent_id = $1`,
      [intentId],
    );
  }

  it('the 24h hold backstop releases a VERIFYING intent nobody resolved', async () => {
    const secured = await overdueSecuredIntent('backstop-verifying');
    await context.intents.transition(
      context.organizationId,
      secured.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
    );
    await context.intents.transition(
      context.organizationId,
      secured.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VERIFYING,
    );
    await holdDeadlinePassed(secured.id);

    const report = await context.expiry.sweep();

    expect(report).toMatchObject({ backstopped: 1, holdsReleased: 1, failed: 0 });
    const after = await context.intents.findById(context.organizationId, secured.id);
    expect(after.status).toBe(PaymentIntentStatus.EXPIRED);
    expect(await context.held(secured.agentAccount)).toBe(0n);
    expect(await context.available(secured.agentAccount)).toBe(5_000_000n);

    // A worker that answers after the backstop loses the compare-and-set.
    await expect(
      context.intents.resolve(
        context.organizationId,
        secured.id,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.SETTLED,
      ),
    ).rejects.toMatchObject({ errorCode: 'PAYMENT_INVALID_STATE_TRANSITION' });
  });

  it('the 24h hold backstop releases a PROVIDER_EXECUTING intent whose worker died', async () => {
    const secured = await overdueSecuredIntent('backstop-executing');
    await context.intents.transition(
      context.organizationId,
      secured.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
    );
    await holdDeadlinePassed(secured.id);

    const report = await context.expiry.sweep();

    expect(report).toMatchObject({ backstopped: 1, holdsReleased: 1 });
    expect(await context.held(secured.agentAccount)).toBe(0n);
  });

  it('a second pass releases nothing more — the balance is restored once', async () => {
    const secured = await overdueSecuredIntent('sweep-twice');
    await context.expiry.sweep();

    const second = await context.expiry.sweep();

    expect(second).toMatchObject({ expired: 0, holdsReleased: 0, repaired: 0, failed: 0 });
    expect(await context.available(secured.agentAccount)).toBe(5_000_000n);
    expect(await context.held(secured.agentAccount)).toBe(0n);
  });

  /**
   * The crash window: a pass that moved the intent to `EXPIRED` and died before
   * the ledger call landed. Nothing in the expirable statuses can see that
   * intent again, so without the repair pass the money would sit reserved until
   * the 24-hour backstop.
   */
  it('repairs an intent expired by a pass that died before releasing the hold', async () => {
    const secured = await overdueSecuredIntent('sweep-repair');
    await context.intents.transition(
      context.organizationId,
      secured.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.EXPIRED,
      { reason: PAYMENT_INTENT_EXPIRY_REASON },
    );

    expect(await context.held(secured.agentAccount)).toBe(1_000_000n);

    const report = await context.expiry.sweep();

    expect(report).toMatchObject({ expired: 0, repaired: 1, failed: 0 });
    const hold = await context.ledger.getHold(context.organizationId, secured.holdId as string);
    expect(hold.status).toBe(LedgerHoldStatus.RELEASED);
    expect(await context.available(secured.agentAccount)).toBe(5_000_000n);
    expect(await context.held(secured.agentAccount)).toBe(0n);
  });

  /**
   * The same crash window on the void edge: `resolve()` commits
   * PROVIDER_EXECUTING → VOIDED, then dies before `releaseHold`. VOIDED is
   * terminal and no other pass reads it, so only the repair pass can return it.
   */
  it('repairs an intent voided by a caller that died before releasing the hold', async () => {
    const secured = await overdueSecuredIntent('void-repair');
    await context.intents.transition(
      context.organizationId,
      secured.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
    );
    await context.intents.transition(
      context.organizationId,
      secured.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VOIDED,
      { reason: 'provider error' },
    );
    expect(await context.held(secured.agentAccount)).toBe(1_000_000n);

    const report = await context.expiry.sweep();

    expect(report).toMatchObject({ repaired: 1, failed: 0 });
    const hold = await context.ledger.getHold(context.organizationId, secured.holdId as string);
    expect(hold.status).toBe(LedgerHoldStatus.RELEASED);
    expect(await context.available(secured.agentAccount)).toBe(5_000_000n);
    expect(await context.held(secured.agentAccount)).toBe(0n);
    const voided = await context.intents.findById(context.organizationId, secured.id);
    expect(voided.holdReleasedAt).not.toBeNull();

    // Repaired once: the next pass finds nothing left to release.
    expect(await context.expiry.sweep()).toMatchObject({ repaired: 0 });
  });

  it('sweeps a backlog of overdue intents in one pass', async () => {
    const labels = ['backlog-a', 'backlog-b', 'backlog-c'];
    const secured = [];
    for (const label of labels) {
      secured.push(await overdueSecuredIntent(label));
    }

    const report = await context.expiry.sweep();

    expect(report).toMatchObject({ expired: 3, holdsReleased: 3, failed: 0 });
    for (const intent of secured) {
      expect(await context.held(intent.agentAccount)).toBe(0n);
      expect(await context.available(intent.agentAccount)).toBe(5_000_000n);
    }
  });

  it('honours the batch bound rather than draining everything at once', async () => {
    await overdueSecuredIntent('batch-a');
    await overdueSecuredIntent('batch-b');

    const first = await context.expiry.sweep(new Date(), 1);
    expect(first.expired).toBe(1);

    const second = await context.expiry.sweep(new Date(), 1);
    expect(second.expired).toBe(1);

    const third = await context.expiry.sweep(new Date(), 1);
    expect(third.expired).toBe(0);
  });
});
