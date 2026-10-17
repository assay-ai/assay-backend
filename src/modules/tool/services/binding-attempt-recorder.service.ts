import { Injectable, Logger } from '@nestjs/common';

import { BindingAttemptRepository } from '@database/postgres/repositories/binding-attempt.repository';

import { Classification } from '../domain/classification';
import { RoutingCallClass, attributeAttempt } from '../domain/routing';
import { ToolBinding } from '../ports/tool.types';

/** One attempt, as the router saw it. */
export interface ObservedAttempt {
  readonly binding: ToolBinding;
  readonly classification: Classification;
  readonly elapsedMs: number;
  /** The budget the attempt was given — `binding.timeoutMs`, or less if the request's deadline cut it. */
  readonly timeoutMs: number;
  readonly callClass?: RoutingCallClass;
  readonly buyerOrganizationId?: string;
}

/**
 * Writes the attempts `attributeAttempt` counts to `binding_attempts`, the raw
 * window behind `ProviderStats`.
 *
 * ## Why the router, and not the MCP loop
 *
 * The router is the only place that sees every attempt. The payment intent
 * and `tool_call_records` name the binding that answered last; an attempt that
 * failed over — exactly the provider-caused `SYSTEM_ERROR` availability is
 * about — is recorded nowhere else, and neither is a paid call's latency.
 *
 * ## Why Postgres and not a Redis counter
 *
 * The codebase keeps its source of truth in Postgres and puts Redis in front
 * of it as a cache (`BindingCallCounterService`), so a flush cannot reset a
 * provider's record. A window of "the last N attempts" also needs the attempts
 * themselves to compute a p95 from, which a counter cannot hold. The table is
 * pruned to that window by the stats refresh, so it stays bounded.
 *
 * ## Off the caller's path, and never throws
 *
 * {@link record} is not awaited by the router: the agent is blocked on the
 * call, and the insert would otherwise add a round trip to every attempt. A
 * write that fails costs one observation out of a thousand; it is logged and
 * dropped, the same trade `BindingCallCounterService.record` makes.
 */
@Injectable()
export class BindingAttemptRecorder {
  private readonly logger = new Logger(BindingAttemptRecorder.name);

  constructor(private readonly attempts: BindingAttemptRepository) {}

  async record(attempt: ObservedAttempt): Promise<void> {
    const { binding, classification } = attempt;
    try {
      const attribution = attributeAttempt({
        responseClass: classification.responseClass,
        reason: classification.reason,
        providerId: binding.providerId,
        buyerOrganizationId: attempt.buyerOrganizationId,
        elapsedMs: attempt.elapsedMs,
        timeoutMs: attempt.timeoutMs,
        bindingTimeoutMs: binding.timeoutMs,
      });
      if (!attribution.counted) return;

      await this.attempts.append({
        bindingId: binding.id,
        providerId: binding.providerId,
        callClass: attempt.callClass ?? null,
        available: attribution.available,
        latencyMs: attribution.latencyMs,
        reason: classification.reason,
      });
    } catch (error) {
      this.logger.warn(
        `binding ${binding.id}: attempt not recorded, its stats will miss one observation. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
