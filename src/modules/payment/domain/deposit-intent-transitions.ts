import { PaymentErrors } from '../errors/payment.errors';
import { DepositIntentStatus } from '../ports/deposit.types';

/**
 * What caused a deposit-intent edge to be taken. Mirrors
 * `PaymentIntentTrigger`'s reasoning: the trigger is not the edge, and the
 * table names every documented cause of each one.
 */
export enum DepositIntentTrigger {
  /** Facilitator `/verify` passed; about to call `/settle`. */
  SETTLEMENT_INITIATED = 'SETTLEMENT_INITIATED',
  /** Facilitator `/settle` succeeded and the on-chain transfer was observed. */
  SETTLEMENT_CONFIRMED = 'SETTLEMENT_CONFIRMED',
  /** Facilitator `/settle` failed, or the observed transfer did not satisfy the intent. */
  SETTLEMENT_REJECTED = 'SETTLEMENT_REJECTED',
  EXPIRY_SWEEP = 'EXPIRY_SWEEP',
}

export interface DepositIntentTransitionRule {
  readonly from: DepositIntentStatus;
  readonly to: DepositIntentStatus;
  readonly triggers: readonly DepositIntentTrigger[];
}

/**
 * **The state machine.** Same discipline as `PAYMENT_INTENT_TRANSITIONS` and
 * for the same reason: an edge not written down does not exist, and
 * `CREATED -> SETTLED` (skipping the CAS that guards `/settle` from running
 * twice) is a bug this table makes structurally unreachable rather than a
 * case a reviewer has to notice is missing from an `if` chain.
 *
 * ### Why `EXPIRED` is reachable only from `CREATED`
 *
 * Once `/verify` has passed and the intent has moved to `SETTLING`, settling
 * a deposit is one synchronous call chain within `DepositService` — there is
 * no worker handoff and no window in which the process could die holding an
 * unresolved `SETTLING` intent the way a payment intent's `PROVIDER_EXECUTING`
 * can outlive the request that opened it. So there is no backstop to design
 * for on that side, and no case where a `SETTLING` intent is still around by
 * the time a sweep would look at it.
 */
export const DEPOSIT_INTENT_TRANSITIONS: readonly DepositIntentTransitionRule[] = [
  {
    from: DepositIntentStatus.CREATED,
    to: DepositIntentStatus.SETTLING,
    triggers: [DepositIntentTrigger.SETTLEMENT_INITIATED],
  },
  {
    from: DepositIntentStatus.CREATED,
    to: DepositIntentStatus.EXPIRED,
    triggers: [DepositIntentTrigger.EXPIRY_SWEEP],
  },
  {
    from: DepositIntentStatus.SETTLING,
    to: DepositIntentStatus.SETTLED,
    triggers: [DepositIntentTrigger.SETTLEMENT_CONFIRMED],
  },
  {
    from: DepositIntentStatus.SETTLING,
    to: DepositIntentStatus.FAILED,
    triggers: [DepositIntentTrigger.SETTLEMENT_REJECTED],
  },
];

const TRANSITION_INDEX: ReadonlyMap<string, DepositIntentTransitionRule> = new Map(
  DEPOSIT_INTENT_TRANSITIONS.map((rule) => [edgeKey(rule.from, rule.to), rule]),
);

export const DEPOSIT_INTENT_ALLOWED_TARGETS: Readonly<
  Record<DepositIntentStatus, readonly DepositIntentStatus[]>
> = Object.freeze(
  Object.values(DepositIntentStatus).reduce(
    (targets, status) => ({
      ...targets,
      [status]: DEPOSIT_INTENT_TRANSITIONS.filter((rule) => rule.from === status).map(
        (rule) => rule.to,
      ),
    }),
    {} as Record<DepositIntentStatus, readonly DepositIntentStatus[]>,
  ),
);

/** `SETTLED`, `FAILED`, `EXPIRED` — the minimal terminal state list for deposits. */
export const DEPOSIT_INTENT_TERMINAL_STATUSES: readonly DepositIntentStatus[] = Object.values(
  DepositIntentStatus,
).filter((status) => DEPOSIT_INTENT_ALLOWED_TARGETS[status].length === 0);

export const DEPOSIT_INTENT_EXPIRABLE_STATUSES: readonly DepositIntentStatus[] = Object.values(
  DepositIntentStatus,
).filter((status) => DEPOSIT_INTENT_ALLOWED_TARGETS[status].includes(DepositIntentStatus.EXPIRED));

export function isTerminalDepositIntentStatus(status: DepositIntentStatus): boolean {
  return DEPOSIT_INTENT_TERMINAL_STATUSES.includes(status);
}

export function findDepositIntentTransition(
  from: DepositIntentStatus,
  to: DepositIntentStatus,
): DepositIntentTransitionRule | undefined {
  return TRANSITION_INDEX.get(edgeKey(from, to));
}

export function requireDepositIntentTransition(
  from: DepositIntentStatus,
  to: DepositIntentStatus,
  context: { readonly intentId?: string } = {},
): DepositIntentTransitionRule {
  const rule = findDepositIntentTransition(from, to);

  if (!rule) {
    throw PaymentErrors.depositInvalidStateTransition({
      intentId: context.intentId,
      from,
      to,
      allowed: DEPOSIT_INTENT_ALLOWED_TARGETS[from]?.join(', ') || 'nothing — terminal state',
    });
  }

  return rule;
}

function edgeKey(from: DepositIntentStatus, to: DepositIntentStatus): string {
  return `${from}->${to}`;
}
