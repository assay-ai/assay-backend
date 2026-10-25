import {
  HoldEffect,
  PAYMENT_INTENT_ALLOWED_TARGETS,
  PAYMENT_INTENT_EXPIRABLE_STATUSES,
  PAYMENT_INTENT_HOLD_BACKSTOP_STATUSES,
  PAYMENT_INTENT_RELEASED_TERMINAL_STATUSES,
  PAYMENT_INTENT_TERMINAL_STATUSES,
  PAYMENT_INTENT_TRANSITIONS,
  PaymentIntentTrigger,
  findPaymentIntentTransition,
  isTerminalPaymentIntentStatus,
  requirePaymentIntentTransition,
} from '@modules/payment/domain/payment-intent-transitions';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { expectErrorCode } from '../helpers/expect-error-code';

const ALL_STATUSES: readonly PaymentIntentStatus[] = Object.values(PaymentIntentStatus);

/**
 * Every edge of the payment-intent state machine, transcribed here independently of the table under test.
 *
 * Written out by hand on purpose: deriving the expectation from
 * `PAYMENT_INTENT_TRANSITIONS` would make this file agree with any table at
 * all, including a wrong one. This list is the diagram; the test is whether the
 * code matches it.
 */
const VALID_EDGES: ReadonlyArray<{
  readonly from: PaymentIntentStatus;
  readonly to: PaymentIntentStatus;
  readonly triggers: readonly PaymentIntentTrigger[];
  readonly holdEffect: HoldEffect;
  readonly why: string;
}> = [
  {
    from: PaymentIntentStatus.CREATED,
    to: PaymentIntentStatus.FUNDS_SECURED,
    triggers: [PaymentIntentTrigger.PAYMENT_AUTHORISED],
    holdEffect: HoldEffect.CREATE,
    why: 'payment authorised — rail A settles, rail B verifies the voucher and takes a hold',
  },
  {
    from: PaymentIntentStatus.CREATED,
    to: PaymentIntentStatus.EXPIRED,
    triggers: [PaymentIntentTrigger.EXPIRY_SWEEP],
    holdEffect: HoldEffect.NONE,
    why: 'the agent never paid; nothing was reserved, so nothing is returned',
  },
  {
    from: PaymentIntentStatus.FUNDS_SECURED,
    to: PaymentIntentStatus.PROVIDER_EXECUTING,
    triggers: [PaymentIntentTrigger.FORWARDED_TO_PROVIDER],
    holdEffect: HoldEffect.NONE,
    why: 'the request is forwarded only once the money behind it is reserved',
  },
  {
    from: PaymentIntentStatus.FUNDS_SECURED,
    to: PaymentIntentStatus.EXPIRED,
    triggers: [PaymentIntentTrigger.EXPIRY_SWEEP],
    holdEffect: HoldEffect.RELEASE,
    why: 'funds were held for a call that never started — the agent gets them back',
  },
  {
    from: PaymentIntentStatus.PROVIDER_EXECUTING,
    to: PaymentIntentStatus.VERIFYING,
    triggers: [PaymentIntentTrigger.RESPONSE_DATA_RESULT],
    holdEffect: HoldEffect.NONE,
    why: 'DATA_RESULT — the agent is unblocked here, and verification runs behind it',
  },
  {
    from: PaymentIntentStatus.PROVIDER_EXECUTING,
    to: PaymentIntentStatus.VOIDED,
    triggers: [
      PaymentIntentTrigger.RESPONSE_SYSTEM_ERROR,
      PaymentIntentTrigger.RESPONSE_REQUEST_ERROR,
    ],
    holdEffect: HoldEffect.RELEASE,
    why: 'SYSTEM_ERROR or REQUEST_ERROR — no charge, no strike, either way',
  },
  {
    from: PaymentIntentStatus.VERIFYING,
    to: PaymentIntentStatus.SETTLED,
    triggers: [PaymentIntentTrigger.VERIFICATION_PASS],
    holdEffect: HoldEffect.COMMIT,
    why: 'PASS — the hold is consumed and the provider is credited',
  },
  {
    from: PaymentIntentStatus.VERIFYING,
    to: PaymentIntentStatus.REFUNDED,
    triggers: [PaymentIntentTrigger.VERIFICATION_FAIL],
    holdEffect: HoldEffect.RELEASE,
    why: 'FAIL — same money as VOIDED, but this one is a strike against the provider',
  },
  {
    from: PaymentIntentStatus.VERIFYING,
    to: PaymentIntentStatus.VOIDED,
    triggers: [PaymentIntentTrigger.VERIFICATION_VOID],
    holdEffect: HoldEffect.RELEASE,
    why: 'MISAPPLIED and other VOID verdicts — the agent is made whole and nobody is blamed',
  },
  {
    from: PaymentIntentStatus.PROVIDER_EXECUTING,
    to: PaymentIntentStatus.EXPIRED,
    triggers: [PaymentIntentTrigger.HOLD_BACKSTOP],
    holdEffect: HoldEffect.RELEASE,
    why: 'the 24h hold backstop — the worker never answered, the agent gets the money back',
  },
  {
    from: PaymentIntentStatus.VERIFYING,
    to: PaymentIntentStatus.EXPIRED,
    triggers: [PaymentIntentTrigger.HOLD_BACKSTOP],
    holdEffect: HoldEffect.RELEASE,
    why: 'the 24h hold backstop — verification never resolved the call',
  },
];

describe('payment intent transition table — every valid edge', () => {
  it.each(VALID_EDGES)('$from → $to is allowed: $why', ({ from, to, triggers, holdEffect }) => {
    const rule = requirePaymentIntentTransition(from, to, { intentId: 'intent-1' });

    expect(rule.from).toBe(from);
    expect(rule.to).toBe(to);
    expect(rule.triggers).toEqual(triggers);
    expect(rule.holdEffect).toBe(holdEffect);
  });

  it('the table holds exactly these edges and no others', () => {
    expect(PAYMENT_INTENT_TRANSITIONS).toHaveLength(VALID_EDGES.length);
    expect(PAYMENT_INTENT_TRANSITIONS.map((rule) => `${rule.from}->${rule.to}`).sort()).toEqual(
      VALID_EDGES.map((edge) => `${edge.from}->${edge.to}`).sort(),
    );
  });

  it('every edge declares at least one trigger', () => {
    for (const rule of PAYMENT_INTENT_TRANSITIONS) {
      expect(rule.triggers.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Each of these is a specific way the money goes wrong, not an arbitrary pair.
 * The table is what makes all of them one rejection instead of five forgotten
 * branches.
 */
describe('payment intent transition table — edges that must be refused', () => {
  it('SETTLED → SETTLED is the double-settlement bug and must fail loudly', () => {
    expectErrorCode(
      () =>
        requirePaymentIntentTransition(PaymentIntentStatus.SETTLED, PaymentIntentStatus.SETTLED),
      PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION,
    );
  });

  it('CREATED → SETTLED would charge an agent that never paid and skip verification entirely', () => {
    expectErrorCode(
      () =>
        requirePaymentIntentTransition(PaymentIntentStatus.CREATED, PaymentIntentStatus.SETTLED),
      PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION,
    );
  });

  it('CREATED → PROVIDER_EXECUTING would make the provider work for free', () => {
    expectErrorCode(
      () =>
        requirePaymentIntentTransition(
          PaymentIntentStatus.CREATED,
          PaymentIntentStatus.PROVIDER_EXECUTING,
        ),
      PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION,
    );
  });

  it('FUNDS_SECURED → SETTLED would settle a call whose result was never verified', () => {
    expectErrorCode(
      () =>
        requirePaymentIntentTransition(
          PaymentIntentStatus.FUNDS_SECURED,
          PaymentIntentStatus.SETTLED,
        ),
      PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION,
    );
  });

  it('REFUNDED → SETTLED would charge an agent that has already been made whole', () => {
    expectErrorCode(
      () =>
        requirePaymentIntentTransition(PaymentIntentStatus.REFUNDED, PaymentIntentStatus.SETTLED),
      PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION,
    );
  });

  it('VERIFYING → EXPIRED and PROVIDER_EXECUTING → EXPIRED belong to the hold backstop alone', () => {
    // The five-minute sweep must never take them: it would release money for
    // a call another worker still owns. Only the 24-hour backstop may.
    for (const from of [PaymentIntentStatus.VERIFYING, PaymentIntentStatus.PROVIDER_EXECUTING]) {
      expect(findPaymentIntentTransition(from, PaymentIntentStatus.EXPIRED)?.triggers).toEqual([
        PaymentIntentTrigger.HOLD_BACKSTOP,
      ]);
    }
  });

  it('VOIDED → PROVIDER_EXECUTING would resurrect a terminal intent', () => {
    expectErrorCode(
      () =>
        requirePaymentIntentTransition(
          PaymentIntentStatus.VOIDED,
          PaymentIntentStatus.PROVIDER_EXECUTING,
        ),
      PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION,
    );
  });

  it('PROVIDER_EXECUTING → REFUNDED would strike a provider before anything was verified', () => {
    expectErrorCode(
      () =>
        requirePaymentIntentTransition(
          PaymentIntentStatus.PROVIDER_EXECUTING,
          PaymentIntentStatus.REFUNDED,
        ),
      PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION,
    );
  });

  it('the rejection names what the source state may actually do', () => {
    let message = '';
    try {
      requirePaymentIntentTransition(PaymentIntentStatus.CREATED, PaymentIntentStatus.SETTLED);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('CREATED → SETTLED');
    expect(message).toContain('FUNDS_SECURED');
    expect(message).toContain('EXPIRED');
  });
});

describe('payment intent transition table — exhaustive over status × status', () => {
  const legal = new Set(VALID_EDGES.map((edge) => `${edge.from}->${edge.to}`));
  const pairs = ALL_STATUSES.flatMap((from) => ALL_STATUSES.map((to) => [from, to] as const));

  it(`covers all ${ALL_STATUSES.length ** 2} ordered pairs`, () => {
    expect(pairs).toHaveLength(64);
  });

  it.each(pairs)('%s → %s', (from, to) => {
    if (legal.has(`${from}->${to}`)) {
      expect(findPaymentIntentTransition(from, to)).toBeDefined();
      return;
    }

    expect(findPaymentIntentTransition(from, to)).toBeUndefined();
    expectErrorCode(
      () => requirePaymentIntentTransition(from, to),
      PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION,
    );
  });

  it('no status may transition to itself', () => {
    for (const status of ALL_STATUSES) {
      expect(findPaymentIntentTransition(status, status)).toBeUndefined();
    }
  });
});

describe('payment intent transition table — what the table derives', () => {
  it('the terminal states are exactly the four the doc names', () => {
    expect([...PAYMENT_INTENT_TERMINAL_STATUSES].sort()).toEqual([
      PaymentIntentStatus.EXPIRED,
      PaymentIntentStatus.REFUNDED,
      PaymentIntentStatus.SETTLED,
      PaymentIntentStatus.VOIDED,
    ]);
  });

  // The repair pass releases any OPEN hold left on these: SETTLED must never be
  // among them (its hold is committed, or on rail B awaits redemption).
  it('the hold-releasing terminal states are exactly EXPIRED, REFUNDED and VOIDED', () => {
    expect([...PAYMENT_INTENT_RELEASED_TERMINAL_STATUSES].sort()).toEqual([
      PaymentIntentStatus.EXPIRED,
      PaymentIntentStatus.REFUNDED,
      PaymentIntentStatus.VOIDED,
    ]);
  });

  it.each(PAYMENT_INTENT_TERMINAL_STATUSES)('%s is terminal and has no outgoing edge', (status) => {
    expect(isTerminalPaymentIntentStatus(status)).toBe(true);
    expect(PAYMENT_INTENT_ALLOWED_TARGETS[status]).toEqual([]);
  });

  it('the expirable states are exactly those with an EXPIRY_SWEEP edge to EXPIRED', () => {
    expect([...PAYMENT_INTENT_EXPIRABLE_STATUSES].sort()).toEqual([
      PaymentIntentStatus.CREATED,
      PaymentIntentStatus.FUNDS_SECURED,
    ]);
  });

  it('PROVIDER_EXECUTING and VERIFYING are not expirable — the 24h hold backstop covers them', () => {
    expect(PAYMENT_INTENT_EXPIRABLE_STATUSES).not.toContain(PaymentIntentStatus.PROVIDER_EXECUTING);
    expect(PAYMENT_INTENT_EXPIRABLE_STATUSES).not.toContain(PaymentIntentStatus.VERIFYING);
    expect([...PAYMENT_INTENT_HOLD_BACKSTOP_STATUSES].sort()).toEqual([
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VERIFYING,
    ]);
  });

  it('allowed targets agree with the table for every status', () => {
    for (const status of ALL_STATUSES) {
      expect([...PAYMENT_INTENT_ALLOWED_TARGETS[status]].sort()).toEqual(
        VALID_EDGES.filter((edge) => edge.from === status)
          .map((edge) => edge.to)
          .sort(),
      );
    }
  });

  it('exactly one edge commits the hold, and it is the one that charges the agent', () => {
    const committing = PAYMENT_INTENT_TRANSITIONS.filter(
      (rule) => rule.holdEffect === HoldEffect.COMMIT,
    );

    expect(committing).toHaveLength(1);
    expect(committing[0].to).toBe(PaymentIntentStatus.SETTLED);
  });

  it('every terminal state other than SETTLED either releases the hold or never had one', () => {
    for (const rule of PAYMENT_INTENT_TRANSITIONS) {
      if (!isTerminalPaymentIntentStatus(rule.to) || rule.to === PaymentIntentStatus.SETTLED) {
        continue;
      }
      expect([HoldEffect.RELEASE, HoldEffect.NONE]).toContain(rule.holdEffect);
    }
  });
});
