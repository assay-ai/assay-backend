/**
 * The per-call export's classification.
 *
 * This is a **different concept** from `payment_intents.call_class`
 * (`PaymentIntentCallClass`, `@modules/payment/ports/payment.types`), and the
 * two are kept in separate files under separate domains on purpose — a reader
 * who conflates them will "simplify" one into the other and lose the
 * distinction provider reconciliation depends on:
 *
 *  - `call_class` is **intrinsic**: what kind of call this was, fixed at the
 *    moment the intent is created, before anything about the outcome is
 *    known.
 *  - {@link CallReconciliationClass} is **derived**: `call_class` combined
 *    with what actually happened — settlement, a void, or nothing yet — into
 *    the vocabulary a provider's finance team reconciles their access log
 *    against. It cannot be computed at creation time because the outcome does
 *    not exist yet, and it must not be *stored* at creation time for the same
 *    reason `call_class` must be — the two are opposite constraints on the
 *    same row.
 *
 * ## The vocabulary
 *
 * The export has eight resolved members. `PAID_UNCREDITED`, `SYSTEM_ERROR` and
 * `REQUEST_ERROR` all describe calls the platform is not paying the provider
 * for. "Credited, uncredited, canary, free, or test with a reason" is a loose
 * summary of this list, not a second vocabulary to reconcile against.
 *
 * **There is no `CANARY` member, deliberately.** A canary call is a real paid
 * call at the normal rate, and labelling it differently in a per-call export a
 * provider can read would let that provider fingerprint the canary generator —
 * the one thing canary sampling exists to prevent them from doing. A canary
 * call is indistinguishable here from any other `PAID_CREDITED` row; a monthly
 * aggregate canary count is the surface meant to reconcile the totals instead,
 * and it has no producer yet.
 *
 * ## `PENDING` — the ninth member
 *
 * The eight members all describe a **resolved** call. This export runs
 * against live `payment_intents` rows, not an after-the-fact settled log, and
 * an intent can be `CREATED` / `FUNDS_SECURED` / `PROVIDER_EXECUTING` /
 * `VERIFYING` at the moment a provider pulls the export mid-window. Three
 * options exist for that row: omit it (violates "every row has a class and no
 * row is unclassified" — an in-flight call is a call, and the export is meant
 * to to explain calls still in flight, not hide them), guess a
 * terminal outcome that has not happened (dishonest, and wrong roughly half
 * the time), or add a ninth, explicitly-labelled bucket. This picks the third
 * and says so here rather than silently overloading one of the eight.
 */

/** `payment_intents.call_class` — kept as a string, not the payment domain's enum. See below. */
export type CallClassValue = 'PAID' | 'FREE' | 'TEST' | 'EXPLORATION';

/** `payment_intents.status` values this function branches on. */
export type IntentStatusValue =
  | 'CREATED'
  | 'FUNDS_SECURED'
  | 'PROVIDER_EXECUTING'
  | 'VERIFYING'
  | 'SETTLED'
  | 'REFUNDED'
  | 'VOIDED'
  | 'EXPIRED';

/** `payment_intents.classification` — the classifier's `ResponseClass`, kept as a string. */
export type ResponseClassValue = 'DATA_RESULT' | 'SYSTEM_ERROR' | 'REQUEST_ERROR' | null;

export enum CallReconciliationClass {
  /** Verified, or not sampled — the provider was credited. */
  PAID_CREDITED = 'PAID_CREDITED',
  /**
   * Rail B: verified and `SETTLED`, but `redeem_voucher` has not landed, so the
   * provider has not been credited yet. Reported apart from `PAID_CREDITED` so
   * the export never claims a credit the earnings ledger does not hold, and a
   * redemption that never lands stays visible rather than reading as paid.
   */
  PAID_AWAITING_REDEMPTION = 'PAID_AWAITING_REDEMPTION',
  /**
   * Rail B: verified and credited, but the voucher could never be redeemed
   * (`DelegateIsRevoked`, …), so the credit came out of platform funds and no
   * platform fee was taken. Reported apart from `PAID_CREDITED` because the
   * chain holds no redemption for it.
   */
  PLATFORM_ABSORBED = 'PLATFORM_ABSORBED',
  /** A `DATA_RESULT` that verification found `FAIL` — not credited, a strike recorded. */
  PAID_UNCREDITED = 'PAID_UNCREDITED',
  /** The relay path — no payment machinery ever ran, regardless of what `status` says. */
  FREE = 'FREE',
  /** The provider's own dry run (the mapping tester). Charges nobody. */
  TEST = 'TEST',
  /** `NEW`-binding exploration traffic, 100% sampled at platform cost. */
  EXPLORATION = 'EXPLORATION',
  /** Excluded from the SLA window for griefing attribution — still credited. */
  EXCLUDED = 'EXCLUDED',
  /** No charge, no strike — an availability-metric outcome. */
  SYSTEM_ERROR = 'SYSTEM_ERROR',
  /** No charge, no strike — a compatibility-metric outcome. */
  REQUEST_ERROR = 'REQUEST_ERROR',
  /**
   * Not resolved yet. See the file comment — this is the one member beyond
   * the eight resolved ones, added because the export runs against live intents.
   */
  PENDING = 'PENDING',
}

/** The minimum a row must carry to be classified for reconciliation. */
export interface CallReconciliationCandidate {
  readonly callClass: CallClassValue;
  readonly status: IntentStatusValue;
  /** The response class recorded on the intent, or `null` if no attempt was ever made. */
  readonly classification: ResponseClassValue;
  /**
   * A rail-B intent whose hold is still open: settled by the verdict, not yet
   * redeemed on chain. Optional; absent means not awaiting.
   */
  readonly awaitingRedemption?: boolean;
  /** Credited from platform funds (`platform_absorbed:` credit). Optional; absent means not. */
  readonly platformAbsorbed?: boolean;
  /**
   * Whether the `SETTLED` intent's hold was committed, which is when
   * `PROVIDER_CREDIT` is written (`CREDITED_SQL`). Optional; absent means
   * credited. `false` is a settled row nobody was credited for — no hold, or a
   * commit that failed after the status moved.
   */
  readonly credited?: boolean;
  /**
   * Whether this call was excluded from its SLA window (griefing
   * attribution). Optional; absent means not excluded. Kept as a real
   * parameter so that adding an exclusion source is a caller change, not a
   * rewrite of this function.
   */
  readonly isExcluded?: boolean;
}

/**
 * `call_class` + the intent's outcome → the export's classification.
 *
 * Pure, and total — every branch of `CallReconciliationCandidate` reaches a
 * member of {@link CallReconciliationClass}. That totality is the thing under
 * test: "every row has a class and no row is unclassified" is a property of
 * this function, not of the query that calls it.
 */
export function classifyForReconciliation(
  candidate: CallReconciliationCandidate,
): CallReconciliationClass {
  // Intrinsic classes win outright. A `FREE` or `TEST` call's `status` can
  // still move through the same state machine as a paid one (a free call can
  // fail verification and land on `REFUNDED`, for instance, because tier
  // progression cares about its outcome even though nobody was charged) —
  // but none of that is what the export means by "credited"/"uncredited", so the
  // outcome is never consulted once the call is known to be one of these.
  if (candidate.callClass === 'FREE') return CallReconciliationClass.FREE;
  if (candidate.callClass === 'TEST') return CallReconciliationClass.TEST;
  if (candidate.callClass === 'EXPLORATION') return CallReconciliationClass.EXPLORATION;

  if (candidate.isExcluded) return CallReconciliationClass.EXCLUDED;

  switch (candidate.status) {
    case 'SETTLED':
      if (candidate.awaitingRedemption) return CallReconciliationClass.PAID_AWAITING_REDEMPTION;
      // Settled with no credit behind it: the money side is unresolved, and
      // calling it PAID_CREDITED would claim a credit the ledger does not hold
      // (BUG-R2-V3-03). The earnings report counts it as neither earned nor withheld.
      if (candidate.credited === false) return CallReconciliationClass.PENDING;
      return candidate.platformAbsorbed
        ? CallReconciliationClass.PLATFORM_ABSORBED
        : CallReconciliationClass.PAID_CREDITED;
    case 'REFUNDED':
      return CallReconciliationClass.PAID_UNCREDITED;
    case 'VOIDED':
    case 'EXPIRED':
      return classifyTerminalError(candidate.classification);
    default:
      // CREATED, FUNDS_SECURED, PROVIDER_EXECUTING, VERIFYING.
      return CallReconciliationClass.PENDING;
  }
}

/**
 * `VOIDED` / `EXPIRED` — reuses the classifier's own vocabulary rather than
 * restating it: these are call classes here as well as
 * response classes there, and a fourth `ResponseClass` member must change
 * exactly one place to be honoured here too.
 */
function classifyTerminalError(classification: ResponseClassValue): CallReconciliationClass {
  if (classification === 'SYSTEM_ERROR') return CallReconciliationClass.SYSTEM_ERROR;
  if (classification === 'REQUEST_ERROR') return CallReconciliationClass.REQUEST_ERROR;

  // No response classification was recorded — the router threw before any
  // provider was selected (`TOOL_NO_ELIGIBLE_BINDING` / `TOOL_ALL_BINDINGS_FAILED`
  // reached from outside the attempt loop; see `ProviderRouterService.route()`'s
  // outer catch in `McpToolCallService.route`, which voids with no
  // `providerId` and no `classification`). A row in a *provider-scoped*
  // export always has `providerId` set — the repository query that produces
  // these candidates filters on it — and `providerId` is written on the same
  // transition as `classification`, so this branch is unreachable for a row
  // that reached this function through that path. Kept as an explicit,
  // labelled fallback rather than silently defaulting, so a future caller
  // that reuses this function against an *unscoped* intent (no such caller
  // exists today) gets a value that is honestly a guess rather than one that
  // looks exactly like a real `SYSTEM_ERROR`.
  //
  // It is also where a `DATA_RESULT` the 24-hour hold backstop expired lands:
  // the provider answered, the platform's worker never resolved the call, so
  // it is our failure — no charge, no strike — which is what `SYSTEM_ERROR` says.
  return CallReconciliationClass.SYSTEM_ERROR;
}

/** Every member, for callers that must render or validate the full set (e.g. CSV headers). */
export const CALL_RECONCILIATION_CLASSES: readonly CallReconciliationClass[] = Object.freeze(
  Object.values(CallReconciliationClass),
);
