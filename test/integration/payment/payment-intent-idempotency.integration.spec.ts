import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { PaymentIntent, PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { BaseError } from '@shared/errors/base.error';

import { PaymentTestContext, createPaymentTestContext } from '../helpers/payment-test-context';

describe('payment intent idempotency — a retry must never become a second charge', () => {
  let context: PaymentTestContext;

  beforeAll(async () => {
    context = await createPaymentTestContext();
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  /** How many intents this agent has, straight from the table. */
  async function intentCount(agentLabel: string): Promise<number> {
    return context.repository.countBy({
      organizationId: context.organizationId,
      agentId: context.id(`${agentLabel}:agent`),
    });
  }

  it('the same key replayed sequentially returns the original intent', async () => {
    const first = await context.createIntent('idem-sequential', {
      idempotencyKey: 'key-sequential',
    });
    const second = await context.createIntent('idem-sequential', {
      idempotencyKey: 'key-sequential',
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(await intentCount('idem-sequential')).toBe(1);
  });

  /**
   * The case the implementation is most likely to get wrong.
   *
   * A look-up-then-insert has a window in which both requests find nothing, and
   * both insert. Only the unique index can close it, so the test fires both
   * inserts at once and asserts on the *table*, not on the return values: two
   * calls returning the same id while two rows exist would be a passing test
   * over a broken ledger.
   */
  it('two simultaneous requests with one key create exactly one intent', async () => {
    const [first, second] = await Promise.all([
      context.createIntent('idem-parallel', { idempotencyKey: 'key-parallel' }),
      context.createIntent('idem-parallel', { idempotencyKey: 'key-parallel' }),
    ]);

    expect(second.id).toBe(first.id);
    expect(await intentCount('idem-parallel')).toBe(1);
  });

  it('eight simultaneous requests with one key still create exactly one intent', async () => {
    const attempts = Array.from({ length: 8 }, () =>
      context.createIntent('idem-storm', { idempotencyKey: 'key-storm' }),
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<PaymentIntent> => result.status === 'fulfilled',
    );

    expect(fulfilled).toHaveLength(8);
    expect(new Set(fulfilled.map((result) => result.value.id)).size).toBe(1);
    expect(await intentCount('idem-storm')).toBe(1);
  });

  it('a key replayed against a different request is a collision, not a retry', async () => {
    await context.createIntent('idem-collision', {
      idempotencyKey: 'key-collision',
      requestHash: 'sha256:weather-lookup',
    });

    let thrown: unknown;
    try {
      await context.createIntent('idem-collision', {
        idempotencyKey: 'key-collision',
        requestHash: 'sha256:expensive-inference',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BaseError);
    expect((thrown as BaseError).errorCode).toBe(PaymentErrorCode.PAYMENT_IDEMPOTENCY_KEY_REUSED);
    expect(await intentCount('idem-collision')).toBe(1);
  });

  it('the replayed intent keeps the status it had reached, not a fresh CREATED', async () => {
    const first = await context.createIntent('idem-status', { idempotencyKey: 'key-status' });
    await context.fund(first.agentAccount, 5_000_000n);
    const secured = await context.intents.secureFunds(context.organizationId, first.id);

    const replay = await context.createIntent('idem-status', { idempotencyKey: 'key-status' });

    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe(secured.status);
    expect(replay.holdId).toBe(secured.holdId);
    // One hold, therefore one reservation — the replay charged nothing again.
    expect(await context.held(first.agentAccount)).toBe(1_000_000n);
  });

  /** CREATED → FUNDS_SECURED → PROVIDER_EXECUTING, the state a routed call is voided from. */
  async function executing(intent: PaymentIntent): Promise<PaymentIntent> {
    await context.fund(intent.agentAccount, 5_000_000n);
    await context.intents.secureFunds(context.organizationId, intent.id);
    return context.intents.transition(
      context.organizationId,
      intent.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
    );
  }

  // ── G2.1: a key is held only while its intent may still charge ───────────

  it('a voided intent releases its key: the retry creates a fresh intent', async () => {
    const first = await context.createIntent('idem-voided', { idempotencyKey: 'key-voided' });
    await executing(first);
    await context.intents.resolve(
      context.organizationId,
      first.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VOIDED,
      { reason: 'test: provider failed' },
    );

    const retry = await context.createIntent('idem-voided', { idempotencyKey: 'key-voided' });

    expect(retry.id).not.toBe(first.id);
    expect(retry.status).toBe(PaymentIntentStatus.CREATED);
    expect(await intentCount('idem-voided')).toBe(2);
    // The hold the void released stays released; only the retry may hold now.
    expect(await context.held(first.agentAccount)).toBe(0n);
  });

  it('a refunded intent releases its key, and its hold stays released', async () => {
    const first = await context.createIntent('idem-refunded', { idempotencyKey: 'key-refunded' });
    await executing(first);
    await context.intents.resolve(
      context.organizationId,
      first.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VERIFYING,
      { reason: 'test: served' },
    );
    await context.intents.resolve(
      context.organizationId,
      first.id,
      PaymentIntentStatus.VERIFYING,
      PaymentIntentStatus.REFUNDED,
      { reason: 'test: verification failed', verificationVerdict: 'SCHEMA_FAIL' },
    );
    expect(await context.held(first.agentAccount)).toBe(0n);

    const retry = await context.createIntent('idem-refunded', { idempotencyKey: 'key-refunded' });

    expect(retry.id).not.toBe(first.id);
    expect(await intentCount('idem-refunded')).toBe(2);
    expect(
      await context.intents.findLiveByIdempotencyKey(
        context.organizationId,
        context.id('idem-refunded:agent'),
        'key-refunded',
      ),
    ).toMatchObject({ id: retry.id });
  });

  it('an expired intent releases its key too', async () => {
    const first = await context.createIntent('idem-expired', { idempotencyKey: 'key-expired' });
    await context.intents.transition(
      context.organizationId,
      first.id,
      PaymentIntentStatus.CREATED,
      PaymentIntentStatus.EXPIRED,
      { reason: 'test: funds not secured' },
    );

    const retry = await context.createIntent('idem-expired', { idempotencyKey: 'key-expired' });

    expect(retry.id).not.toBe(first.id);
    expect(await intentCount('idem-expired')).toBe(2);
  });

  it('after a void and a retry, the key replays the LIVE intent, not the dead one', async () => {
    const first = await context.createIntent('idem-live', { idempotencyKey: 'key-live' });
    await executing(first);
    await context.intents.resolve(
      context.organizationId,
      first.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VOIDED,
    );
    const retry = await context.createIntent('idem-live', { idempotencyKey: 'key-live' });

    const [third, fourth] = await Promise.all([
      context.createIntent('idem-live', { idempotencyKey: 'key-live' }),
      context.createIntent('idem-live', { idempotencyKey: 'key-live' }),
    ]);

    expect(third.id).toBe(retry.id);
    expect(fourth.id).toBe(retry.id);
    expect(await intentCount('idem-live')).toBe(2);
  });

  it('an intent still executing keeps its key: the retry gets that intent and no second hold', async () => {
    const first = await context.createIntent('idem-running', { idempotencyKey: 'key-running' });
    await executing(first);

    const retry = await context.createIntent('idem-running', { idempotencyKey: 'key-running' });

    expect(retry.id).toBe(first.id);
    expect(retry.status).toBe(PaymentIntentStatus.PROVIDER_EXECUTING);
    expect(await context.held(first.agentAccount)).toBe(1_000_000n);
  });

  it('without a key, two identical requests are two intents — idempotency is opt-in', async () => {
    const first = await context.createIntent('idem-absent');
    const second = await context.createIntent('idem-absent');

    expect(second.id).not.toBe(first.id);
    expect(await intentCount('idem-absent')).toBe(2);
  });

  it('the same key from two different agents is two intents — keys are scoped per agent', async () => {
    const first = await context.createIntent('idem-agent-a', { idempotencyKey: 'shared-key' });
    const second = await context.createIntent('idem-agent-b', { idempotencyKey: 'shared-key' });

    expect(second.id).not.toBe(first.id);
    expect(await intentCount('idem-agent-a')).toBe(1);
    expect(await intentCount('idem-agent-b')).toBe(1);
  });

  it('the same key in another organization is another intent', async () => {
    const first = await context.createIntent('idem-tenant', { idempotencyKey: 'tenant-key' });
    await context.reset();
    const second = await context.createIntent('idem-tenant', { idempotencyKey: 'tenant-key' });

    expect(second.id).not.toBe(first.id);
  });
});
