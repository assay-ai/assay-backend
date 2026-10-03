import { Money } from '@modules/chains/ports/money.types';
import { displayPrice } from '@modules/mcp/services/mcp-catalogue.service';

import { FreeQuotaRefused } from './free-quota.service';

/**
 * The `x402/error` + `x402/paymentRequired` `_meta` shape a free-quota
 * exhaustion carries, built from a {@link FreeQuotaRefused} decision.
 *
 * ```jsonc
 * "_meta": {
 *   "x402/error": { "code": "FREE_QUOTA_EXHAUSTED", "retryable": true, "resetsAt": "…" },
 *   "x402/paymentRequired": { "toolId": "…", "price": { … } }   // present only on FREEMIUM
 * }
 * ```
 *
 * ## Why this is a plain function, not something that throws
 *
 * `McpErrors.quotaExceeded` already exists (429, `RETRYABLE_CODES`) and the
 * orchestrator's relay branch throws it — this module deliberately does not
 * wrap that decision, because throwing is `mcp-tool-call.service.ts`'s call to
 * make (which transition the intent-less free call needs, if any, before it
 * fails). What this function owns is *only* the payload: given a refusal,
 * produce the `context` object `McpErrors.quotaExceeded(context)` should carry
 * so that `resetsAt` and the paid option survive to the agent.
 *
 * `McpErrors.quotaExceeded`'s message template reads `context.limit` and
 * `context.paidAlternative` (for the human-readable string), and
 * `McpServerFactory.toErrorResult` spreads the same context into `_meta`,
 * lifting `paymentRequired` into `_meta[x402/paymentRequired]` — that is how
 * `resetsAt` and the paid option reach the agent.
 */
export interface FreeQuotaErrorContext {
  /** `McpErrors.quotaExceeded`'s message template reads this. */
  readonly limit: string;
  /**
   * `McpErrors.quotaExceeded`'s message template interpolates this directly
   * into a sentence — a tool id, not the full payment-required object.
   */
  readonly paidAlternative?: string;
  /** ISO-8601. When the exhausted limit resets. */
  readonly resetsAt: string;
  /** The full `x402/paymentRequired` object, present only when `fallThroughToPaid`. */
  readonly paymentRequired?: FreeQuotaPaymentRequired;
}

/**
 * "The paid option, so the agent can simply pay" — what `x402/paymentRequired`
 * must contain here.
 *
 * Deliberately **not** the full x402 `{ x402Version, accepts: […] }` envelope
 * an unfunded agent receives for a genuinely unfunded wallet: building that
 * requires a chain-specific facilitator negotiation
 * (`src/modules/chains/facilitator/**`, and not needed here — the agent funding
 * this call already has a balance; it simply has not been charged for this tool
 * before). This is the tool's own paid price, exactly what `tools/list` already
 * quoted as `x402/price` for the same tool once it stops being free.
 */
export interface FreeQuotaPaymentRequired {
  readonly toolId: string;
  readonly price: {
    readonly amount: string;
    readonly asset: string;
    readonly display: string;
  };
}

export interface BuildFreeQuotaErrorContextInput {
  readonly refusal: FreeQuotaRefused;
  readonly toolId: string;
  /** The tool's paid price — from `ToolQuote.price`. Required when `refusal.fallThroughToPaid`. */
  readonly paidPrice: Money | null;
}

export function buildFreeQuotaErrorContext(
  input: BuildFreeQuotaErrorContextInput,
): FreeQuotaErrorContext {
  const paymentRequired =
    input.refusal.fallThroughToPaid && input.paidPrice
      ? {
          toolId: input.toolId,
          price: {
            amount: input.paidPrice.amount,
            asset: input.paidPrice.asset,
            display: displayPrice(input.paidPrice),
          },
        }
      : undefined;

  return {
    limit: input.refusal.limit,
    paidAlternative: paymentRequired ? input.toolId : undefined,
    resetsAt: input.refusal.resetsAt.toISOString(),
    paymentRequired,
  };
}
