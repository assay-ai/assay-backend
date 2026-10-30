import { AccountId } from '@modules/chains/ports/caip.types';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { McpFailureCode, VoucherRequirement } from '@modules/mcp/services/mcp-tool-call.service';
import { PaidPriceFloor } from '@modules/payment/domain/paid-price-floor';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { PaymentRail } from '@modules/payment/ports/payment.types';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { AppError } from '@shared/errors/app-errors';

import {
  ScriptedInvoker,
  buildBinding,
  buildProvider,
  ok,
  usdc,
} from '../tool/helpers/routing-fixtures';
import { offerSolanaRailBInThisSuite } from '../helpers/solana-rail-b';
import { CHAIN_ID, SESSION, buildMcpHarness, fakeVoucherSignature } from './helpers/mcp-harness';

/**
 * The paid-call minimum at rail-B admission (owner decision 2026-10-30).
 *
 * A paid call to a binding priced below the minimum — one written before the
 * floor existed — is refused before a seq is allocated, a voucher verified or
 * a hold taken, with a non-retryable `PAYMENT_PRICE_BELOW_MINIMUM`. Free calls
 * never reach the check, and an exempt (internal) provider is admitted.
 */
const PROVIDER = 'provider-a';
const AGENT = `${CHAIN_ID}:Agent1111111111111111111111111111111111111` as AccountId;
const RAIL_B_SESSION: McpSession = { ...SESSION, agentAccount: AGENT };
const ARGS = { query: 'moon landing' };
const TOOL_NAME = 'Search the web';

function floor(exempt: string[] = []): PaidPriceFloor {
  return { minUsd: '0.10', exemptProviderIds: new Set(exempt) };
}

function harness(priceAmount: string, priceFloor: PaidPriceFloor, pricingMode = PricingMode.PAID) {
  const invoker = new ScriptedInvoker({ [`binding-${PROVIDER}`]: async () => ok('forty-two') });
  return buildMcpHarness({
    bindings: [
      buildBinding(PROVIDER, {
        pricingMode,
        priceAmount,
        ...(pricingMode === PricingMode.FREE ? { freeQuotaPerAgent: 100 } : {}),
      }),
    ],
    providers: [buildProvider(PROVIDER)],
    invoker,
    paidPriceFloor: priceFloor,
  });
}

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a refusal');
}

describe('McpToolCallService — paid price floor at rail-B admission', () => {
  offerSolanaRailBInThisSuite();

  it('refuses a paid call to an old binding below the minimum before any seq, voucher or hold', async () => {
    // $0.001: what a binding written before the floor may still charge.
    const h = harness(usdc('0.001').amount, floor());

    const error = await refusal(
      h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, {
        rail: PaymentRail.RAIL_B_VOUCHER,
        voucher: null,
      }),
    );

    expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_PRICE_BELOW_MINIMUM);
    expect(error.statusCode).toBeGreaterThanOrEqual(400);
    expect(error.statusCode).toBeLessThan(500);
    expect(error.message).toContain('must raise its price');
    expect(error.message).toContain('$0.10');
    expect(h.seqs.allocated).toEqual([]);
    expect(h.intents.rows.size).toBe(0);
  });

  it('refuses the voucher-carrying retry too, without verifying the voucher', async () => {
    const h = harness(usdc('0.05').amount, floor());
    const voucher = {
      payer: AGENT,
      payTo: AGENT,
      provider: AGENT,
      amount: { amount: usdc('0.05').amount, asset: usdc('0.05').asset, decimals: 6 },
      resource: `/mcp/tools/${TOOL_NAME}`,
      requestHash: `sha256:${'cd'.repeat(32)}`,
      seq: '1',
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    };

    const error = await refusal(
      h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, {
        rail: null,
        voucher: {
          signed: { voucher, signature: fakeVoucherSignature(AGENT) },
          providerId: PROVIDER,
        },
      } as never),
    );

    expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_PRICE_BELOW_MINIMUM);
    expect(h.intents.rows.size).toBe(0);
  });

  it('admits exactly the minimum: the buyer is asked to sign', async () => {
    const h = harness(usdc('0.10').amount, floor());

    const outcome = await h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, {
      rail: PaymentRail.RAIL_B_VOUCHER,
      voucher: null,
    });

    if (outcome.kind !== 'ERROR') throw new Error('expected a payment requirement');
    expect(outcome.code).toBe(McpFailureCode.PAYMENT_REQUIRED);
    expect((outcome.detail.paymentRequired as VoucherRequirement).amount.amount).toBe('100000');
    expect(h.seqs.allocated).toEqual(['1']);
  });

  it('admits an exempt (internal) provider below the minimum', async () => {
    const h = harness(usdc('0.001').amount, floor([PROVIDER]));

    const outcome = await h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, {
      rail: PaymentRail.RAIL_B_VOUCHER,
      voucher: null,
    });

    if (outcome.kind !== 'ERROR') throw new Error('expected a payment requirement');
    expect(outcome.code).toBe(McpFailureCode.PAYMENT_REQUIRED);
    expect((outcome.detail.paymentRequired as VoucherRequirement).amount.amount).toBe('1000');
  });

  it('still refuses a non-exempt provider when another provider is exempt', async () => {
    const h = harness(usdc('0.001').amount, floor(['provider-internal']));

    const error = await refusal(
      h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, {
        rail: PaymentRail.RAIL_B_VOUCHER,
        voucher: null,
      }),
    );

    expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_PRICE_BELOW_MINIMUM);
  });

  it('leaves free calls untouched', async () => {
    const h = harness('0', floor(), PricingMode.FREE);

    const outcome = await h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS);

    if (outcome.kind !== 'RESULT') throw new Error('expected a RESULT');
    expect(outcome.receipt.charged.amount).toBe('0');
    expect(h.seqs.allocated).toEqual([]);
  });
});

describe('ProviderRouterService.offer — the paid price floor in the draw', () => {
  offerSolanaRailBInThisSuite();

  const CHEAP = 'provider-cheap';
  const FAIR = 'provider-fair';

  function market(
    prices: Record<string, string>,
    options: { exempt?: string[]; unstaked?: string[]; random?: () => number } = {},
  ) {
    const ids = Object.keys(prices);
    const invoker = new ScriptedInvoker(
      Object.fromEntries(ids.map((id) => [`binding-${id}`, async () => ok('forty-two')])),
    );
    return buildMcpHarness({
      bindings: ids.map((id) => buildBinding(id, { priceAmount: prices[id] })),
      providers: ids.map((id) => buildProvider(id)),
      stakes: Object.fromEntries(
        ids.filter((id) => !options.unstaked?.includes(id)).map((id) => [id, usdc(1000)]),
      ),
      invoker,
      random: options.random,
      paidPriceFloor: floor(options.exempt),
    });
  }

  async function offeredProvider(h: ReturnType<typeof market>): Promise<string> {
    const outcome = await h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, {
      rail: PaymentRail.RAIL_B_VOUCHER,
      voucher: null,
    });
    if (outcome.kind !== 'ERROR') throw new Error('expected a payment requirement');
    return (outcome.detail.paymentRequired as VoucherRequirement).providerId;
  }

  it('skips a binding below the minimum while another can serve, on every draw', async () => {
    for (const draw of [0, 0.25, 0.5, 0.75, 0.999]) {
      const h = market(
        { [CHEAP]: usdc('0.001').amount, [FAIR]: usdc('0.10').amount },
        { random: () => draw },
      );
      expect(await offeredProvider(h)).toBe(FAIR);
    }
  });

  it('refuses PAYMENT_PRICE_BELOW_MINIMUM only when every candidate is below it', async () => {
    const h = market({ [CHEAP]: usdc('0.001').amount, [FAIR]: usdc('0.05').amount });

    const error = await refusal(
      h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, {
        rail: PaymentRail.RAIL_B_VOUCHER,
        voucher: null,
      }),
    );

    expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_PRICE_BELOW_MINIMUM);
    expect(h.seqs.allocated).toEqual([]);
  });

  it('falls back to the cheap binding — and refuses — when the one above it cannot serve', async () => {
    // The fair provider has no stake: the router cannot route to it, so the
    // refusal names the price, not "no eligible binding".
    const h = market(
      { [CHEAP]: usdc('0.001').amount, [FAIR]: usdc('0.10').amount },
      { unstaked: [FAIR] },
    );

    const error = await refusal(
      h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, {
        rail: PaymentRail.RAIL_B_VOUCHER,
        voucher: null,
      }),
    );

    expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_PRICE_BELOW_MINIMUM);
  });

  it('treats an exempt provider below the minimum as eligible, and skips the non-exempt one', async () => {
    for (const draw of [0, 0.5, 0.999]) {
      const h = market(
        { [CHEAP]: usdc('0.001').amount, [FAIR]: usdc('0.002').amount },
        { exempt: [FAIR], random: () => draw },
      );
      expect(await offeredProvider(h)).toBe(FAIR);
    }
  });
});
