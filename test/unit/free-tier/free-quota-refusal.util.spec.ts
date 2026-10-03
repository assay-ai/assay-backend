import { buildFreeQuotaErrorContext } from '@modules/free-tier/services/free-quota-refusal.util';
import {
  FreeQuotaLimitKind,
  FreeQuotaRefused,
} from '@modules/free-tier/services/free-quota.service';

import { usdc } from '../tool/helpers/routing-fixtures';

const RESETS_AT = new Date('2026-08-21T00:00:00.000Z');
const TOOL_ID = 'search_web';

function refusal(overrides: Partial<FreeQuotaRefused> = {}): FreeQuotaRefused {
  return {
    kind: 'REFUSED',
    limit: FreeQuotaLimitKind.PROVIDER_PER_AGENT_DAILY,
    resetsAt: RESETS_AT,
    fallThroughToPaid: false,
    ...overrides,
  };
}

/**
 * When the free quota is exhausted, the response must carry `paidAlternative`
 * in the correct format. The exhaustion response is shaped:
 *
 * ```jsonc
 * "_meta": {
 *   "x402/error": { "code": "FREE_QUOTA_EXHAUSTED", "retryable": true, "resetsAt": "…" },
 *   "x402/paymentRequired": { … }
 * }
 * ```
 *
 * so "the correct format" is asserted here as: `resetsAt` present and
 * ISO-8601, and a `paymentRequired` object present *only* when the refusal
 * says the paid path is reachable (`FREEMIUM`), carrying the tool id and its
 * paid price — never present, and never fabricated, for a `FREE`-only
 * exhaustion with no paid path through this tool.
 */
describe('buildFreeQuotaErrorContext — the paidAlternative format', () => {
  it('FREEMIUM: carries a fully-formed paymentRequired, and paidAlternative names the tool', () => {
    const context = buildFreeQuotaErrorContext({
      refusal: refusal({ fallThroughToPaid: true }),
      toolId: TOOL_ID,
      paidPrice: usdc('0.05'),
    });

    expect(context.resetsAt).toBe(RESETS_AT.toISOString());
    expect(context.paidAlternative).toBe(TOOL_ID);
    expect(context.paymentRequired).toEqual({
      toolId: TOOL_ID,
      price: { amount: usdc('0.05').amount, asset: usdc('0.05').asset, display: '$0.05' },
    });
  });

  it('FREE: no paid path exists, so paymentRequired and paidAlternative are both absent', () => {
    const context = buildFreeQuotaErrorContext({
      refusal: refusal({ fallThroughToPaid: false }),
      toolId: TOOL_ID,
      paidPrice: null,
    });

    expect(context.resetsAt).toBe(RESETS_AT.toISOString());
    expect(context.paidAlternative).toBeUndefined();
    expect(context.paymentRequired).toBeUndefined();
  });

  it('never fabricates paymentRequired when fallThroughToPaid is true but no price was supplied', () => {
    // Defensive: a caller that says "fall through" but cannot actually name a
    // price (the quote disappeared underneath the call) must not publish a
    // paymentRequired object with a missing or invented price.
    const context = buildFreeQuotaErrorContext({
      refusal: refusal({ fallThroughToPaid: true }),
      toolId: TOOL_ID,
      paidPrice: null,
    });

    expect(context.paymentRequired).toBeUndefined();
    expect(context.paidAlternative).toBeUndefined();
  });

  it('always carries limit, for the message template that reads context.limit', () => {
    const context = buildFreeQuotaErrorContext({
      refusal: refusal({ limit: FreeQuotaLimitKind.PLATFORM_RATE_LIMIT }),
      toolId: TOOL_ID,
      paidPrice: null,
    });

    expect(context.limit).toBe(FreeQuotaLimitKind.PLATFORM_RATE_LIMIT);
  });
});
