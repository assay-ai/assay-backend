import { ClassificationReason, ResponseClass } from '../classification/classification.types';
import type { RoutingCallClass } from './routing.types';

/**
 * Which routing attempts count toward a binding's observed stats.
 *
 * The stats move traffic, so they may only measure what the **provider**
 * caused, on traffic somebody paid for. Everything else is left out rather
 * than counted in either direction:
 *
 * | attempt                                             | counted | available | latency |
 * | --------------------------------------------------- | ------- | --------- | ------- |
 * | `DATA_RESULT` (good or bad data alike)              | yes     | yes       | yes     |
 * | `SYSTEM_ERROR`, timeout on the longest budget it    | yes     | no        | yes     |
 * |   could ever get (`min(binding, request deadline)`) |         |           |         |
 * | `SYSTEM_ERROR`, any other recognised provider cause | yes     | no        | no      |
 * | `SYSTEM_ERROR`, `MAPPING_FAULT_PLATFORM`            | no — our selector, not their server      |
 * | `SYSTEM_ERROR`, `PLATFORM_UNAVAILABLE`              | no — we could not prepare the call       |
 * | `SYSTEM_ERROR`, `TRANSPORT_UNKNOWN`                 | no — an unrecognised throw is not evidence |
 * | timeout on a budget earlier attempts had spent      | no — the time went elsewhere             |
 * | `REQUEST_ERROR`                                     | no — the agent's arguments               |
 * | a `FREE` call, or one whose class was not given     | no — free traffic costs a caller nothing |
 * | no buyer organization named                         | no — the per-buyer cap needs one         |
 * | the buyer organization is the provider              | no — a self-call can only wash the stats |
 *
 * ## Why only paid traffic
 *
 * A free call costs the caller nothing, so anyone can generate as many as they
 * like — successes to inflate a provider, failures to sink a competitor. A
 * paid `SYSTEM_ERROR` is voided and costs nothing either, which is why the
 * refresh also caps how many attempts any one buyer organization contributes
 * to a binding's window (`BINDING_STATS_MAX_PER_BUYER`): one buyer, however
 * many calls it makes, moves a binding by at most that many observations.
 * Self-calls are excluded outright; the wider wash and sybil rules belong to
 * G1.4.
 *
 * Nothing that never reached an attempt is here at all, by construction:
 * eligibility refusals (`CHAIN_NOT_SETTLEABLE`, `BUYER_WITHDRAWING`, ...),
 * failover exclusions, ceiling sheds, free-quota sheds and spend-policy
 * refusals are decided before a binding is dialled, and the router records
 * only attempts. `IneligibilityReason` documents each of those as "never a
 * provider-quality event"; this table is where that promise is kept.
 *
 * A timeout is a latency sample as well as an unavailability: the provider
 * held the call for the whole budget, and a p95 that left those calls out
 * would make a provider that hangs look fast. A refused connection is not a
 * latency sample, because the few milliseconds it took say nothing about how
 * long the provider takes to answer.
 *
 * Whether the data was *good* is verification's question, answered separately
 * as `paidQualityRate`. Availability only asks whether the provider answered.
 */

/**
 * Slack on "had the full budget". The first attempt's budget is the request
 * deadline minus the few milliseconds spent selecting it, so an exact
 * comparison would call every first attempt on a long-timeout binding cut
 * short — and a hanging endpoint would never be marked unavailable.
 */
export const FULL_BUDGET_TOLERANCE_MS = 250;

/** Why an attempt was left out of the stats. */
export enum AttemptNotCountedReason {
  SELF_CALL = 'SELF_CALL',
  NO_BUYER = 'NO_BUYER',
  NOT_PAID = 'NOT_PAID',
  REQUEST_ERROR = 'REQUEST_ERROR',
  PLATFORM_FAULT = 'PLATFORM_FAULT',
  UNRECOGNISED_FAILURE = 'UNRECOGNISED_FAILURE',
  BUDGET_CUT_SHORT = 'BUDGET_CUT_SHORT',
}

export interface AttemptAttributionInput {
  readonly responseClass: ResponseClass;
  readonly reason: ClassificationReason;
  readonly providerId: string;
  /** The buying organization; `null` or absent when the caller did not say. */
  readonly buyerOrganizationId?: string | null;
  /** `PAID` or `FREE`; absent when the caller did not say. */
  readonly callClass?: RoutingCallClass;
  readonly elapsedMs: number;
  /** The budget the attempt was given. */
  readonly timeoutMs: number;
  /**
   * The longest budget any attempt on this binding could be given:
   * `min(binding.timeoutMs, totalDeadlineMs)`. A binding may declare more time
   * than a whole request is allowed, and the router never grants it.
   */
  readonly maxBudgetMs: number;
}

export type AttemptAttribution =
  | { readonly counted: false; readonly why: AttemptNotCountedReason }
  | { readonly counted: true; readonly available: boolean; readonly latencyMs: number | null };

export function attributeAttempt(input: AttemptAttributionInput): AttemptAttribution {
  if (!input.buyerOrganizationId) {
    return { counted: false, why: AttemptNotCountedReason.NO_BUYER };
  }
  if (input.buyerOrganizationId === input.providerId) {
    return { counted: false, why: AttemptNotCountedReason.SELF_CALL };
  }
  if (input.callClass !== 'PAID') {
    return { counted: false, why: AttemptNotCountedReason.NOT_PAID };
  }

  const latencyMs = Math.max(0, Math.round(input.elapsedMs));

  switch (input.responseClass) {
    case ResponseClass.DATA_RESULT:
      return { counted: true, available: true, latencyMs };

    case ResponseClass.REQUEST_ERROR:
      return { counted: false, why: AttemptNotCountedReason.REQUEST_ERROR };

    case ResponseClass.SYSTEM_ERROR:
      if (
        input.reason === ClassificationReason.MAPPING_FAULT_PLATFORM ||
        input.reason === ClassificationReason.PLATFORM_UNAVAILABLE
      ) {
        return { counted: false, why: AttemptNotCountedReason.PLATFORM_FAULT };
      }
      // `classifyTransportError`'s fallback for a throw it does not
      // recognise — by its own contract "not evidence of provider
      // misbehaviour", and as likely to be our bug as theirs.
      if (input.reason === ClassificationReason.TRANSPORT_UNKNOWN) {
        return { counted: false, why: AttemptNotCountedReason.UNRECOGNISED_FAILURE };
      }
      if (input.reason === ClassificationReason.TRANSPORT_TIMEOUT) {
        // The router clips an attempt's budget to what is left of the whole
        // request's deadline. A provider that timed out on a budget earlier
        // attempts had already eaten into may well have answered inside the
        // one it would normally get.
        if (input.timeoutMs + FULL_BUDGET_TOLERANCE_MS < input.maxBudgetMs) {
          return { counted: false, why: AttemptNotCountedReason.BUDGET_CUT_SHORT };
        }
        return { counted: true, available: false, latencyMs };
      }
      return { counted: true, available: false, latencyMs: null };
  }
}
