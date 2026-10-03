import { PaymentErrors } from '../errors/payment.errors';
import { PaymentIntentStatus } from '../ports/payment.types';

/**
 * What caused an edge to be taken.
 *
 * The trigger is not the edge: `SYSTEM_ERROR` and `REQUEST_ERROR` are two
 * triggers of one edge, because for money they are the same thing — no charge —
 * and the difference between them (a strike against the provider) is carried by
 * the response classification, not by the state machine.
 */
export enum PaymentIntentTrigger {
  /** Rail A: facilitator `/verify` + `/settle`. Rail B: voucher verified. */
  PAYMENT_AUTHORISED = 'PAYMENT_AUTHORISED',
  FORWARDED_TO_PROVIDER = 'FORWARDED_TO_PROVIDER',
  RESPONSE_DATA_RESULT = 'RESPONSE_DATA_RESULT',
  RESPONSE_SYSTEM_ERROR = 'RESPONSE_SYSTEM_ERROR',
  RESPONSE_REQUEST_ERROR = 'RESPONSE_REQUEST_ERROR',
  VERIFICATION_PASS = 'VERIFICATION_PASS',
  VERIFICATION_FAIL = 'VERIFICATION_FAIL',
  EXPIRY_SWEEP = 'EXPIRY_SWEEP',
}

/** What the ledger must do to the intent's hold when an edge is taken. */
export enum HoldEffect {
  /** The edge opens the reservation: `available` → `held`. */
  CREATE = 'CREATE',
  /** The agent is made whole: `held` → `available`. */
  RELEASE = 'RELEASE',
  /** The reservation is consumed and the value leaves the account. */
  COMMIT = 'COMMIT',
  NONE = 'NONE',
}

export interface PaymentIntentTransitionRule {
  readonly from: PaymentIntentStatus;
  readonly to: PaymentIntentStatus;
  /** Every documented cause of this edge. Never empty. */
  readonly triggers: readonly PaymentIntentTrigger[];
  readonly holdEffect: HoldEffect;
}

/**
 * **The state machine. Every legal move an intent can make is on this list, and
 * nothing else is legal.**
 *
 * It is a table rather than a chain of conditionals for three reasons, and the
 * third is the one that matters:
 *
 * 1. it can be read against the payment-intent state diagram line by line;
 * 2. a test can enumerate `status × status` and assert that exactly these eight
 *    pairs are accepted, which no `if` chain can be checked against;
 * 3. **an edge that is not written down does not exist.** A conditional fails
 *    open — the case nobody thought about falls through to whatever the last
 *    branch does. A table fails closed: the lookup misses and the caller gets
 *    `PAYMENT_INVALID_STATE_TRANSITION`. `SETTLED → SETTLED` is the double
 *    settlement bug, and it must fail loudly rather than be quietly ignored.
 *
 * ### Why `EXPIRED` is reachable from only two states
 *
 * The sweep catches intents that never got moving. Once the request has been
 * forwarded (`PROVIDER_EXECUTING`) or handed to verification (`VERIFYING`) the
 * intent is in another worker's hands, and a sweeper that expired it out from
 * under that worker would release money for a call that is about to return
 * data.
 *
 * The intended design covers those two states with a *second* backstop — the
 * 24-hour hold expiry, releasing in the agent's favour if the worker dies.
 * **That backstop is not implemented.** `ledger_holds.expires_at` is written
 * and read by nothing; there is one mechanism, not two, and the window this
 * table leaves open is genuinely open. The design is the target; this comment
 * is the current state.
 */
export const PAYMENT_INTENT_TRANSITIONS: readonly PaymentIntentTransitionRule[] = [
  {
    from: PaymentIntentStatus.CREATED,
    to: PaymentIntentStatus.FUNDS_SECURED,
    triggers: [PaymentIntentTrigger.PAYMENT_AUTHORISED],
    holdEffect: HoldEffect.CREATE,
  },
  {
    // Nothing was ever reserved, so there is nothing to give back.
    from: PaymentIntentStatus.CREATED,
    to: PaymentIntentStatus.EXPIRED,
    triggers: [PaymentIntentTrigger.EXPIRY_SWEEP],
    holdEffect: HoldEffect.NONE,
  },
  {
    from: PaymentIntentStatus.FUNDS_SECURED,
    to: PaymentIntentStatus.PROVIDER_EXECUTING,
    triggers: [PaymentIntentTrigger.FORWARDED_TO_PROVIDER],
    holdEffect: HoldEffect.NONE,
  },
  {
    from: PaymentIntentStatus.FUNDS_SECURED,
    to: PaymentIntentStatus.EXPIRED,
    triggers: [PaymentIntentTrigger.EXPIRY_SWEEP],
    holdEffect: HoldEffect.RELEASE,
  },
  {
    // The agent is unblocked here, not at a terminal state: it receives data
    // plus a receipt reference while verification runs behind it.
    from: PaymentIntentStatus.PROVIDER_EXECUTING,
    to: PaymentIntentStatus.VERIFYING,
    triggers: [PaymentIntentTrigger.RESPONSE_DATA_RESULT],
    holdEffect: HoldEffect.NONE,
  },
  {
    // No charge and no strike, whichever of the two triggers fired.
    from: PaymentIntentStatus.PROVIDER_EXECUTING,
    to: PaymentIntentStatus.VOIDED,
    triggers: [
      PaymentIntentTrigger.RESPONSE_SYSTEM_ERROR,
      PaymentIntentTrigger.RESPONSE_REQUEST_ERROR,
    ],
    holdEffect: HoldEffect.RELEASE,
  },
  {
    from: PaymentIntentStatus.VERIFYING,
    to: PaymentIntentStatus.SETTLED,
    triggers: [PaymentIntentTrigger.VERIFICATION_PASS],
    holdEffect: HoldEffect.COMMIT,
  },
  {
    // Same money as VOIDED, different accountability: this one is a strike.
    from: PaymentIntentStatus.VERIFYING,
    to: PaymentIntentStatus.REFUNDED,
    triggers: [PaymentIntentTrigger.VERIFICATION_FAIL],
    holdEffect: HoldEffect.RELEASE,
  },
];

const TRANSITION_INDEX: ReadonlyMap<string, PaymentIntentTransitionRule> = new Map(
  PAYMENT_INTENT_TRANSITIONS.map((rule) => [edgeKey(rule.from, rule.to), rule]),
);

/**
 * Outgoing edges per state, derived from the table.
 *
 * Derived rather than written a second time: two hand-maintained lists of the
 * same facts disagree eventually, and the disagreement shows up as an edge that
 * the machine allows and the documentation denies.
 */
export const PAYMENT_INTENT_ALLOWED_TARGETS: Readonly<
  Record<PaymentIntentStatus, readonly PaymentIntentStatus[]>
> = Object.freeze(
  Object.values(PaymentIntentStatus).reduce(
    (targets, status) => ({
      ...targets,
      [status]: PAYMENT_INTENT_TRANSITIONS.filter((rule) => rule.from === status).map(
        (rule) => rule.to,
      ),
    }),
    {} as Record<PaymentIntentStatus, readonly PaymentIntentStatus[]>,
  ),
);

/**
 * The states no edge leaves.
 *
 * `SETTLED`, `REFUNDED`, `VOIDED`, `EXPIRED` — the terminal-state list, which
 * a unit test asserts rather than trusts.
 */
export const PAYMENT_INTENT_TERMINAL_STATUSES: readonly PaymentIntentStatus[] = Object.values(
  PaymentIntentStatus,
).filter((status) => PAYMENT_INTENT_ALLOWED_TARGETS[status].length === 0);

/** The states the expiry sweep may act on — exactly those with an `EXPIRED` edge. */
export const PAYMENT_INTENT_EXPIRABLE_STATUSES: readonly PaymentIntentStatus[] = Object.values(
  PaymentIntentStatus,
).filter((status) => PAYMENT_INTENT_ALLOWED_TARGETS[status].includes(PaymentIntentStatus.EXPIRED));

export function isTerminalPaymentIntentStatus(status: PaymentIntentStatus): boolean {
  return PAYMENT_INTENT_TERMINAL_STATUSES.includes(status);
}

/** The rule for an edge, or `undefined` if the edge is not on the table. */
export function findPaymentIntentTransition(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
): PaymentIntentTransitionRule | undefined {
  return TRANSITION_INDEX.get(edgeKey(from, to));
}

/**
 * The rule for an edge, or `PAYMENT_INVALID_STATE_TRANSITION`.
 *
 * Pure, so the whole machine is exhaustively testable without a database, and
 * so the transactional code has exactly one thing left to get right: applying
 * the decision atomically.
 */
export function requirePaymentIntentTransition(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
  context: { readonly intentId?: string } = {},
): PaymentIntentTransitionRule {
  const rule = findPaymentIntentTransition(from, to);

  if (!rule) {
    throw PaymentErrors.invalidStateTransition({
      intentId: context.intentId,
      from,
      to,
      allowed: PAYMENT_INTENT_ALLOWED_TARGETS[from]?.join(', ') || 'nothing — terminal state',
    });
  }

  return rule;
}

function edgeKey(from: PaymentIntentStatus, to: PaymentIntentStatus): string {
  return `${from}->${to}`;
}
