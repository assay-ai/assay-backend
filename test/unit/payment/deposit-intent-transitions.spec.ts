import {
  DEPOSIT_INTENT_ALLOWED_TARGETS,
  DEPOSIT_INTENT_EXPIRABLE_STATUSES,
  DEPOSIT_INTENT_TERMINAL_STATUSES,
  DEPOSIT_INTENT_TRANSITIONS,
  DepositIntentTrigger,
  findDepositIntentTransition,
  isTerminalDepositIntentStatus,
  requireDepositIntentTransition,
} from '@modules/payment/domain/deposit-intent-transitions';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { DepositIntentStatus } from '@modules/payment/ports/deposit.types';
import { expectErrorCode } from '../helpers/expect-error-code';

const ALL_STATUSES: readonly DepositIntentStatus[] = Object.values(DepositIntentStatus);

/**
 * Every edge of the deposit-intent state machine, transcribed here
 * independently of the table under test — same reasoning as
 * `payment-intent-transitions.spec.ts`: deriving the expectation from
 * `DEPOSIT_INTENT_TRANSITIONS` would make the test agree with any table,
 * including a wrong one.
 */
const VALID_EDGES: ReadonlyArray<{
  readonly from: DepositIntentStatus;
  readonly to: DepositIntentStatus;
  readonly triggers: readonly DepositIntentTrigger[];
  readonly why: string;
}> = [
  {
    from: DepositIntentStatus.CREATED,
    to: DepositIntentStatus.SETTLING,
    triggers: [DepositIntentTrigger.SETTLEMENT_INITIATED],
    why: 'facilitator /verify passed; about to call /settle',
  },
  {
    from: DepositIntentStatus.CREATED,
    to: DepositIntentStatus.EXPIRED,
    triggers: [DepositIntentTrigger.EXPIRY_SWEEP],
    why: 'the SVM blockhash bound elapsed before the client ever funded it',
  },
  {
    from: DepositIntentStatus.SETTLING,
    to: DepositIntentStatus.SETTLED,
    triggers: [DepositIntentTrigger.SETTLEMENT_CONFIRMED],
    why: '/settle succeeded and the on-chain transfer was observed',
  },
  {
    from: DepositIntentStatus.SETTLING,
    to: DepositIntentStatus.FAILED,
    triggers: [DepositIntentTrigger.SETTLEMENT_REJECTED],
    why: '/settle failed, or the observed transfer did not satisfy the intent',
  },
];

describe('deposit intent transition table — every valid edge', () => {
  it.each(VALID_EDGES)('$from -> $to is allowed: $why', ({ from, to, triggers }) => {
    const rule = requireDepositIntentTransition(from, to, { intentId: 'deposit-1' });

    expect(rule.from).toBe(from);
    expect(rule.to).toBe(to);
    expect(rule.triggers).toEqual(triggers);
  });

  it('the table holds exactly these edges and no others', () => {
    expect(DEPOSIT_INTENT_TRANSITIONS).toHaveLength(VALID_EDGES.length);
    expect(DEPOSIT_INTENT_TRANSITIONS.map((rule) => `${rule.from}->${rule.to}`).sort()).toEqual(
      VALID_EDGES.map((edge) => `${edge.from}->${edge.to}`).sort(),
    );
  });

  it('every edge declares at least one trigger', () => {
    for (const rule of DEPOSIT_INTENT_TRANSITIONS) {
      expect(rule.triggers.length).toBeGreaterThan(0);
    }
  });
});

describe('deposit intent transition table — edges that must be refused', () => {
  it('SETTLED -> SETTLED is the double-credit bug and must fail loudly', () => {
    expectErrorCode(
      () =>
        requireDepositIntentTransition(DepositIntentStatus.SETTLED, DepositIntentStatus.SETTLED),
      PaymentErrorCode.PAYMENT_DEPOSIT_INVALID_STATE_TRANSITION,
    );
  });

  it('CREATED -> SETTLED would credit an agent whose deposit was never verified or settled', () => {
    expectErrorCode(
      () =>
        requireDepositIntentTransition(DepositIntentStatus.CREATED, DepositIntentStatus.SETTLED),
      PaymentErrorCode.PAYMENT_DEPOSIT_INVALID_STATE_TRANSITION,
    );
  });

  it('FAILED -> SETTLED would resurrect a rejected settlement into a credited one', () => {
    expectErrorCode(
      () => requireDepositIntentTransition(DepositIntentStatus.FAILED, DepositIntentStatus.SETTLED),
      PaymentErrorCode.PAYMENT_DEPOSIT_INVALID_STATE_TRANSITION,
    );
  });

  it('SETTLING -> EXPIRED would expire an in-flight settlement out from under itself', () => {
    expectErrorCode(
      () =>
        requireDepositIntentTransition(DepositIntentStatus.SETTLING, DepositIntentStatus.EXPIRED),
      PaymentErrorCode.PAYMENT_DEPOSIT_INVALID_STATE_TRANSITION,
    );
  });

  it('EXPIRED -> SETTLING would revive a dead deposit intent', () => {
    expectErrorCode(
      () =>
        requireDepositIntentTransition(DepositIntentStatus.EXPIRED, DepositIntentStatus.SETTLING),
      PaymentErrorCode.PAYMENT_DEPOSIT_INVALID_STATE_TRANSITION,
    );
  });
});

describe('deposit intent transition table — exhaustive over status x status', () => {
  const legal = new Set(VALID_EDGES.map((edge) => `${edge.from}->${edge.to}`));
  const pairs = ALL_STATUSES.flatMap((from) => ALL_STATUSES.map((to) => [from, to] as const));

  it(`covers all ${ALL_STATUSES.length ** 2} ordered pairs`, () => {
    expect(pairs).toHaveLength(25);
  });

  it.each(pairs)('%s -> %s', (from, to) => {
    if (legal.has(`${from}->${to}`)) {
      expect(findDepositIntentTransition(from, to)).toBeDefined();
      return;
    }

    expect(findDepositIntentTransition(from, to)).toBeUndefined();
    expectErrorCode(
      () => requireDepositIntentTransition(from, to),
      PaymentErrorCode.PAYMENT_DEPOSIT_INVALID_STATE_TRANSITION,
    );
  });

  it('no status may transition to itself', () => {
    for (const status of ALL_STATUSES) {
      expect(findDepositIntentTransition(status, status)).toBeUndefined();
    }
  });
});

describe('deposit intent transition table — what the table derives', () => {
  it('the terminal states are exactly SETTLED, FAILED, EXPIRED', () => {
    expect([...DEPOSIT_INTENT_TERMINAL_STATUSES].sort()).toEqual([
      DepositIntentStatus.EXPIRED,
      DepositIntentStatus.FAILED,
      DepositIntentStatus.SETTLED,
    ]);
  });

  it.each(DEPOSIT_INTENT_TERMINAL_STATUSES)('%s is terminal and has no outgoing edge', (status) => {
    expect(isTerminalDepositIntentStatus(status)).toBe(true);
    expect(DEPOSIT_INTENT_ALLOWED_TARGETS[status]).toEqual([]);
  });

  it('the expirable states are exactly CREATED', () => {
    expect([...DEPOSIT_INTENT_EXPIRABLE_STATUSES].sort()).toEqual([DepositIntentStatus.CREATED]);
  });

  it('SETTLING is not expirable — settling a deposit has no worker handoff to outlive', () => {
    expect(DEPOSIT_INTENT_EXPIRABLE_STATUSES).not.toContain(DepositIntentStatus.SETTLING);
  });

  it('allowed targets agree with the table for every status', () => {
    for (const status of ALL_STATUSES) {
      expect([...DEPOSIT_INTENT_ALLOWED_TARGETS[status]].sort()).toEqual(
        VALID_EDGES.filter((edge) => edge.from === status)
          .map((edge) => edge.to)
          .sort(),
      );
    }
  });
});
