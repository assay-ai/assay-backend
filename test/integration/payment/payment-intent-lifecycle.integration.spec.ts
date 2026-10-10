import { PAYMENT_INTENT_TRANSITIONS } from '@modules/payment/domain/payment-intent-transitions';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { PaymentIntent, PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { BaseError } from '@shared/errors/base.error';

import { PaymentTestContext, createPaymentTestContext } from '../helpers/payment-test-context';

/** The code of a rejected promise, asserting it is a `BaseError` on the way. */
async function codeOfRejection(work: () => Promise<unknown>): Promise<string> {
  let thrown: unknown;
  try {
    await work();
  } catch (error) {
    thrown = error;
  }

  if (thrown === undefined) {
    throw new Error('Expected the call to reject, but it resolved');
  }

  expect(thrown).toBeInstanceOf(BaseError);
  return (thrown as BaseError).errorCode;
}

describe('payment intent state machine against Postgres', () => {
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

  /**
   * Drives a fresh intent to `target` along the only path the table allows,
   * funding the agent first so the `FUNDS_SECURED` edge can really open a hold.
   *
   * Every state is reached by walking the machine rather than by writing a
   * status straight into the row: a test that sets up its precondition by
   * bypassing the thing under test proves the thing under test was bypassable.
   */
  async function driveTo(label: string, target: PaymentIntentStatus): Promise<PaymentIntent> {
    const intent = await context.createIntent(label);
    if (target === PaymentIntentStatus.CREATED) {
      return intent;
    }

    await context.fund(intent.agentAccount, 5_000_000n);
    let current = await context.intents.secureFunds(context.organizationId, intent.id);
    if (target === PaymentIntentStatus.FUNDS_SECURED) {
      return current;
    }

    current = await context.intents.transition(
      context.organizationId,
      intent.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
    );
    if (target === PaymentIntentStatus.PROVIDER_EXECUTING) {
      return current;
    }

    current = await context.intents.transition(
      context.organizationId,
      intent.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VERIFYING,
    );
    if (target === PaymentIntentStatus.VERIFYING) {
      return current;
    }

    throw new Error(`driveTo does not know how to reach ${target}`);
  }

  describe('every valid edge of the table, taken for real', () => {
    it('CREATED → FUNDS_SECURED opens the ledger hold that secures the price', async () => {
      const intent = await context.createIntent('edge-funds-secured');
      await context.fund(intent.agentAccount, 5_000_000n);

      const secured = await context.intents.secureFunds(context.organizationId, intent.id);

      expect(secured.status).toBe(PaymentIntentStatus.FUNDS_SECURED);
      expect(secured.holdId).not.toBeNull();
      expect(await context.held(intent.agentAccount)).toBe(1_000_000n);
      expect(await context.available(intent.agentAccount)).toBe(4_000_000n);
    });

    it('CREATED → EXPIRED is allowed and records why', async () => {
      const intent = await driveTo('edge-created-expired', PaymentIntentStatus.CREATED);

      const expired = await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.CREATED,
        PaymentIntentStatus.EXPIRED,
        { reason: 'deadline elapsed' },
      );

      expect(expired.status).toBe(PaymentIntentStatus.EXPIRED);
      expect(expired.statusReason).toBe('deadline elapsed');
    });

    it('FUNDS_SECURED → PROVIDER_EXECUTING is allowed', async () => {
      const intent = await driveTo('edge-executing', PaymentIntentStatus.FUNDS_SECURED);

      const forwarded = await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.FUNDS_SECURED,
        PaymentIntentStatus.PROVIDER_EXECUTING,
      );

      expect(forwarded.status).toBe(PaymentIntentStatus.PROVIDER_EXECUTING);
    });

    it('FUNDS_SECURED → EXPIRED is allowed', async () => {
      const intent = await driveTo('edge-secured-expired', PaymentIntentStatus.FUNDS_SECURED);

      const expired = await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.FUNDS_SECURED,
        PaymentIntentStatus.EXPIRED,
      );

      expect(expired.status).toBe(PaymentIntentStatus.EXPIRED);
    });

    it('PROVIDER_EXECUTING → VERIFYING is allowed — the agent is unblocked here', async () => {
      const intent = await driveTo('edge-verifying', PaymentIntentStatus.PROVIDER_EXECUTING);

      const verifying = await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        PaymentIntentStatus.VERIFYING,
        { classification: 'DATA_RESULT' },
      );

      expect(verifying.status).toBe(PaymentIntentStatus.VERIFYING);
      expect(verifying.classification).toBe('DATA_RESULT');
    });

    it('PROVIDER_EXECUTING → VOIDED is allowed', async () => {
      const intent = await driveTo('edge-voided', PaymentIntentStatus.PROVIDER_EXECUTING);

      const voided = await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        PaymentIntentStatus.VOIDED,
        { classification: 'SYSTEM_ERROR' },
      );

      expect(voided.status).toBe(PaymentIntentStatus.VOIDED);
      expect(voided.classification).toBe('SYSTEM_ERROR');
    });

    it('VERIFYING → SETTLED is allowed and records what the chain actually moved', async () => {
      const intent = await driveTo('edge-settled', PaymentIntentStatus.VERIFYING);

      const settled = await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.SETTLED,
        { verificationVerdict: 'PASS', settledAmount: context.usdc(1_000_500n) },
      );

      expect(settled.status).toBe(PaymentIntentStatus.SETTLED);
      expect(settled.verificationVerdict).toBe('PASS');
      // Overpayment is legal on SVM's `exact` scheme, and the ledger accounts
      // for what arrived rather than for what was quoted.
      expect(settled.settledAmount?.amount).toBe('1000500');
    });

    it('VERIFYING → REFUNDED is allowed', async () => {
      const intent = await driveTo('edge-refunded', PaymentIntentStatus.VERIFYING);

      const refunded = await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.REFUNDED,
        { verificationVerdict: 'FAIL' },
      );

      expect(refunded.status).toBe(PaymentIntentStatus.REFUNDED);
      expect(refunded.verificationVerdict).toBe('FAIL');
    });

    it('the eight edges exercised above, plus the two hold-backstop edges, are the whole table', () => {
      // The two `HOLD_BACKSTOP` edges are taken for real in
      // `payment-intent-expiry.integration.spec.ts`.
      expect(PAYMENT_INTENT_TRANSITIONS).toHaveLength(10);
    });
  });

  describe('edges outside the table are refused before Postgres is touched', () => {
    it('SETTLED → SETTLED — the double-settlement bug', async () => {
      const intent = await driveTo('bad-double-settle', PaymentIntentStatus.VERIFYING);
      await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.SETTLED,
      );

      const code = await codeOfRejection(() =>
        context.intents.transition(
          context.organizationId,
          intent.id,
          PaymentIntentStatus.SETTLED,
          PaymentIntentStatus.SETTLED,
        ),
      );

      expect(code).toBe(PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION);
      const after = await context.intents.findById(context.organizationId, intent.id);
      expect(after.status).toBe(PaymentIntentStatus.SETTLED);
    });

    it('CREATED → SETTLED — charging without payment or verification', async () => {
      const intent = await driveTo('bad-created-settled', PaymentIntentStatus.CREATED);

      const code = await codeOfRejection(() =>
        context.intents.transition(
          context.organizationId,
          intent.id,
          PaymentIntentStatus.CREATED,
          PaymentIntentStatus.SETTLED,
        ),
      );

      expect(code).toBe(PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION);
      const after = await context.intents.findById(context.organizationId, intent.id);
      expect(after.status).toBe(PaymentIntentStatus.CREATED);
    });

    it('CREATED → PROVIDER_EXECUTING — making the provider work for free', async () => {
      const intent = await driveTo('bad-created-executing', PaymentIntentStatus.CREATED);

      const code = await codeOfRejection(() =>
        context.intents.transition(
          context.organizationId,
          intent.id,
          PaymentIntentStatus.CREATED,
          PaymentIntentStatus.PROVIDER_EXECUTING,
        ),
      );

      expect(code).toBe(PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION);
      const after = await context.intents.findById(context.organizationId, intent.id);
      expect(after.status).toBe(PaymentIntentStatus.CREATED);
    });

    it('FUNDS_SECURED → SETTLED — settling a result nobody verified', async () => {
      const intent = await driveTo('bad-secured-settled', PaymentIntentStatus.FUNDS_SECURED);

      const code = await codeOfRejection(() =>
        context.intents.transition(
          context.organizationId,
          intent.id,
          PaymentIntentStatus.FUNDS_SECURED,
          PaymentIntentStatus.SETTLED,
        ),
      );

      expect(code).toBe(PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION);
      const after = await context.intents.findById(context.organizationId, intent.id);
      expect(after.status).toBe(PaymentIntentStatus.FUNDS_SECURED);
      // The hold is still open: nothing was committed behind the refusal.
      expect(await context.held(intent.agentAccount)).toBe(1_000_000n);
    });

    it('REFUNDED → SETTLED — charging an agent already made whole', async () => {
      const intent = await driveTo('bad-refunded-settled', PaymentIntentStatus.VERIFYING);
      await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.REFUNDED,
      );

      const code = await codeOfRejection(() =>
        context.intents.transition(
          context.organizationId,
          intent.id,
          PaymentIntentStatus.REFUNDED,
          PaymentIntentStatus.SETTLED,
        ),
      );

      expect(code).toBe(PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION);
      const after = await context.intents.findById(context.organizationId, intent.id);
      expect(after.status).toBe(PaymentIntentStatus.REFUNDED);
    });

    it('VOIDED → PROVIDER_EXECUTING — resurrecting a terminal intent', async () => {
      const intent = await driveTo('bad-voided-executing', PaymentIntentStatus.PROVIDER_EXECUTING);
      await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        PaymentIntentStatus.VOIDED,
      );

      const code = await codeOfRejection(() =>
        context.intents.transition(
          context.organizationId,
          intent.id,
          PaymentIntentStatus.VOIDED,
          PaymentIntentStatus.PROVIDER_EXECUTING,
        ),
      );

      expect(code).toBe(PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION);
      const after = await context.intents.findById(context.organizationId, intent.id);
      expect(after.status).toBe(PaymentIntentStatus.VOIDED);
    });
  });

  describe('the compare-and-swap, which is what makes an edge atomic', () => {
    it('a legal edge taken from a stale read is refused, and the error names the real status', async () => {
      const intent = await driveTo('stale-read', PaymentIntentStatus.PROVIDER_EXECUTING);

      let message = '';
      try {
        // A worker that read the intent while it was still FUNDS_SECURED.
        await context.intents.transition(
          context.organizationId,
          intent.id,
          PaymentIntentStatus.FUNDS_SECURED,
          PaymentIntentStatus.PROVIDER_EXECUTING,
        );
      } catch (error) {
        expect((error as BaseError).errorCode).toBe(
          PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION,
        );
        message = (error as Error).message;
      }

      expect(message).toContain('PROVIDER_EXECUTING');
    });

    it('two workers racing one edge produce exactly one winner', async () => {
      const intent = await driveTo('race-one-edge', PaymentIntentStatus.VERIFYING);

      const results = await Promise.allSettled([
        context.intents.transition(
          context.organizationId,
          intent.id,
          PaymentIntentStatus.VERIFYING,
          PaymentIntentStatus.SETTLED,
        ),
        context.intents.transition(
          context.organizationId,
          intent.id,
          PaymentIntentStatus.VERIFYING,
          PaymentIntentStatus.SETTLED,
        ),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

      const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect((loser.reason as BaseError).errorCode).toBe(
        PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION,
      );
    });

    it('a settle and a refund racing each other resolve one way, not both', async () => {
      const intent = await driveTo('race-settle-refund', PaymentIntentStatus.VERIFYING);

      const results = await Promise.allSettled([
        context.intents.transition(
          context.organizationId,
          intent.id,
          PaymentIntentStatus.VERIFYING,
          PaymentIntentStatus.SETTLED,
        ),
        context.intents.transition(
          context.organizationId,
          intent.id,
          PaymentIntentStatus.VERIFYING,
          PaymentIntentStatus.REFUNDED,
        ),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

      const after = await context.intents.findById(context.organizationId, intent.id);
      expect([PaymentIntentStatus.SETTLED, PaymentIntentStatus.REFUNDED]).toContain(after.status);
    });

    it('transitioning an intent that does not exist is a 404, not a silent no-op', async () => {
      const code = await codeOfRejection(() =>
        context.intents.transition(
          context.organizationId,
          context.id('no-such-intent'),
          PaymentIntentStatus.CREATED,
          PaymentIntentStatus.FUNDS_SECURED,
        ),
      );

      expect(code).toBe(PaymentErrorCode.PAYMENT_INTENT_NOT_FOUND);
    });

    it('an intent belonging to another organization is not visible', async () => {
      const intent = await driveTo('tenant-boundary', PaymentIntentStatus.CREATED);
      await context.reset();

      const code = await codeOfRejection(() =>
        context.intents.findById(context.organizationId, intent.id),
      );

      expect(code).toBe(PaymentErrorCode.PAYMENT_INTENT_NOT_FOUND);
    });
  });

  describe('what the row records', () => {
    it('the fee split is stored and adds back up to the price', async () => {
      const intent = await context.createIntent('fee-split');

      expect(intent.price.amount).toBe('1000000');
      expect(intent.platformFee.amount).toBe('100000');
      expect(intent.providerAmount.amount).toBe('900000');
    });

    it('securing funds that the agent does not have leaves the intent in CREATED', async () => {
      const intent = await context.createIntent('unfunded');
      await context.fund(intent.agentAccount, 10n);

      await expect(
        context.intents.secureFunds(context.organizationId, intent.id),
      ).rejects.toBeInstanceOf(BaseError);

      const after = await context.intents.findById(context.organizationId, intent.id);
      expect(after.status).toBe(PaymentIntentStatus.CREATED);
      expect(after.holdId).toBeNull();
    });
  });
});
