import { ClassificationReason, ResponseClass } from '../classification/classification.types';

/**
 * Which routing attempts count toward a binding's observed stats.
 *
 * The stats move traffic, so they may only measure what the **provider**
 * caused. Everything else — the agent's mistake, our own bug, a budget this
 * request spent elsewhere, a provider calling itself — is left out rather than
 * counted in either direction:
 *
 * | attempt                                         | counted | available | latency |
 * | ----------------------------------------------- | ------- | --------- | ------- |
 * | `DATA_RESULT` (good or bad data alike)          | yes     | yes       | yes     |
 * | `SYSTEM_ERROR`, timeout at the binding's budget | yes     | no        | yes     |
 * | `SYSTEM_ERROR`, any other provider-side cause   | yes     | no        | no      |
 * | `SYSTEM_ERROR`, `MAPPING_FAULT_PLATFORM`        | no — our selector, not their server     |
 * | timeout on a budget the request had cut short   | no — earlier attempts spent the time    |
 * | `REQUEST_ERROR`                                 | no — the agent's arguments              |
 * | the buyer organization is the provider          | no — a self-call can only wash the stats |
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

/** Why an attempt was left out of the stats. */
export enum AttemptNotCountedReason {
  SELF_CALL = 'SELF_CALL',
  REQUEST_ERROR = 'REQUEST_ERROR',
  PLATFORM_FAULT = 'PLATFORM_FAULT',
  BUDGET_CUT_SHORT = 'BUDGET_CUT_SHORT',
}

export interface AttemptAttributionInput {
  readonly responseClass: ResponseClass;
  readonly reason: ClassificationReason;
  readonly providerId: string;
  /** The buying organization; `null` or absent when the caller did not say. */
  readonly buyerOrganizationId?: string | null;
  readonly elapsedMs: number;
  /** The budget the attempt was given. */
  readonly timeoutMs: number;
  /** The binding's own declared timeout. */
  readonly bindingTimeoutMs: number;
}

export type AttemptAttribution =
  | { readonly counted: false; readonly why: AttemptNotCountedReason }
  | { readonly counted: true; readonly available: boolean; readonly latencyMs: number | null };

export function attributeAttempt(input: AttemptAttributionInput): AttemptAttribution {
  if (input.buyerOrganizationId && input.buyerOrganizationId === input.providerId) {
    return { counted: false, why: AttemptNotCountedReason.SELF_CALL };
  }

  const latencyMs = Math.max(0, Math.round(input.elapsedMs));

  switch (input.responseClass) {
    case ResponseClass.DATA_RESULT:
      return { counted: true, available: true, latencyMs };

    case ResponseClass.REQUEST_ERROR:
      return { counted: false, why: AttemptNotCountedReason.REQUEST_ERROR };

    case ResponseClass.SYSTEM_ERROR:
      if (input.reason === ClassificationReason.MAPPING_FAULT_PLATFORM) {
        return { counted: false, why: AttemptNotCountedReason.PLATFORM_FAULT };
      }
      if (input.reason === ClassificationReason.TRANSPORT_TIMEOUT) {
        // The router clips an attempt's budget to what is left of the whole
        // request's deadline. A provider that timed out on a budget shorter
        // than the one it declared may well have answered inside its own.
        if (input.timeoutMs < input.bindingTimeoutMs) {
          return { counted: false, why: AttemptNotCountedReason.BUDGET_CUT_SHORT };
        }
        return { counted: true, available: false, latencyMs };
      }
      return { counted: true, available: false, latencyMs: null };
  }
}
