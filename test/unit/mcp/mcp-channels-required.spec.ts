import { AccountId } from '@modules/chains/ports/caip.types';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { McpFailureCode } from '@modules/mcp/services/mcp-tool-call.service';
import { CHANNEL_SCHEME } from '@modules/payment/constants/channel.constants';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { PaymentRail } from '@modules/payment/ports/payment.types';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { AppError } from '@shared/errors/app-errors';

import { ScriptedInvoker, buildBinding, buildProvider, ok } from '../tool/helpers/routing-fixtures';
import { offerSolanaRailBInThisSuite } from '../helpers/solana-rail-b';
import { CHAIN_ID, SESSION, buildMcpHarness, fakeVoucherSignature } from './helpers/mcp-harness';

/**
 * Channel-only paid calls (`EVM_CHANNELS_REQUIRED_CHAINS`, owner decision
 * 2026-11-04): a client that does not offer `channel-v1` is refused with
 * `PAYMENT_CHANNEL_REQUIRED` before a seq, voucher check or hold, on the
 * requirement and on a per-call retry. A client that offers `channel-v1`
 * keeps the per-call fallback; chains not required are untouched.
 */
const PROVIDER = 'provider-a';
const AGENT = `${CHAIN_ID}:Agent1111111111111111111111111111111111111` as AccountId;
const SESSION_B: McpSession = { ...SESSION, agentAccount: AGENT };
const ARGS = { query: 'usd eur' };
const TOOL = 'Search the web';

function build(required: boolean, pricingMode = PricingMode.PAID, recentLane = false) {
  const invoker = new ScriptedInvoker({ [`binding-${PROVIDER}`]: async () => ok('1.08') });
  const refusesPerCallOnly = jest.fn(
    async (input: { chainId: string }) => required && input.chainId === CHAIN_ID && !recentLane,
  );
  const channelAdmission = {
    refusesPerCallOnly,
    requirement: jest.fn(async () => null),
    admit: jest.fn(async () => {
      throw new Error('the channel door must not be reached');
    }),
  };
  const h = buildMcpHarness({
    bindings: [
      buildBinding(PROVIDER, {
        pricingMode,
        ...(pricingMode === PricingMode.FREE ? { priceAmount: '0', freeQuotaPerAgent: 100 } : {}),
      }),
    ],
    providers: [buildProvider(PROVIDER)],
    invoker,
    channelAdmission,
  });
  return { ...h, channelAdmission };
}

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a refusal');
}

function perCallRetry(schemes?: string[]) {
  const now = Math.floor(Date.now() / 1000);
  const voucher = {
    payer: AGENT,
    payTo: AGENT,
    provider: AGENT,
    amount: { amount: '100000', asset: 'x', decimals: 6 },
    resource: `/mcp/tools/${TOOL}`,
    requestHash: `sha256:${'cd'.repeat(32)}`,
    seq: '1',
    issuedAt: now,
    expiresAt: now + 120,
  };
  return {
    rail: null,
    voucher: { signed: { voucher, signature: fakeVoucherSignature(AGENT) }, providerId: PROVIDER },
    ...(schemes ? { schemes } : {}),
  } as never;
}

describe('McpToolCallService — channels required (EVM_CHANNELS_REQUIRED_CHAINS)', () => {
  offerSolanaRailBInThisSuite();

  it('refuses the requirement of a client that offers no scheme, before any seq or intent', async () => {
    const h = build(true);

    const error = await refusal(
      h.calls.call(SESSION_B, TOOL, ARGS, { rail: PaymentRail.RAIL_B_VOUCHER, voucher: null }),
    );

    expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_CHANNEL_REQUIRED);
    expect(error.statusCode).toBe(409);
    expect(error.message).toContain('@goassay-ai/sdk 1.2.0');
    expect(error.message).toContain('Nothing was charged');
    expect(h.seqs.allocated).toEqual([]);
    expect(h.intents.rows.size).toBe(0);
  });

  it('refuses a client whose schemes do not include channel-v1', async () => {
    const h = build(true);

    const error = await refusal(
      h.calls.call(SESSION_B, TOOL, ARGS, {
        rail: PaymentRail.RAIL_B_VOUCHER,
        voucher: null,
        schemes: ['voucher'],
      } as never),
    );

    expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_CHANNEL_REQUIRED);
    expect(h.seqs.allocated).toEqual([]);
  });

  it('refuses an old client’s per-call voucher retry without verifying or holding it', async () => {
    const h = build(true);

    const error = await refusal(h.calls.call(SESSION_B, TOOL, ARGS, perCallRetry()));

    expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_CHANNEL_REQUIRED);
    expect(h.intents.rows.size).toBe(0);
  });

  it('asks a client that offers channel-v1 to pay, and asks the door for its offer', async () => {
    const h = build(true);

    const outcome = await h.calls.call(SESSION_B, TOOL, ARGS, {
      rail: PaymentRail.RAIL_B_VOUCHER,
      voucher: null,
      schemes: [CHANNEL_SCHEME],
    } as never);

    if (outcome.kind !== 'ERROR') throw new Error('expected a payment requirement');
    expect(outcome.code).toBe(McpFailureCode.PAYMENT_REQUIRED);
    expect(h.channelAdmission.requirement).toHaveBeenCalledTimes(1);
    expect(h.seqs.allocated).toEqual(['1']);
  });

  it('lets a payer with a recent lane pay per call without channel-v1 (a paused 1.2.0 client)', async () => {
    const h = build(true, PricingMode.PAID, true);

    const outcome = await h.calls.call(SESSION_B, TOOL, ARGS, {
      rail: PaymentRail.RAIL_B_VOUCHER,
      voucher: null,
    });

    if (outcome.kind !== 'ERROR') throw new Error('expected a payment requirement');
    expect(outcome.code).toBe(McpFailureCode.PAYMENT_REQUIRED);
    expect(h.channelAdmission.refusesPerCallOnly).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: CHAIN_ID, payer: AGENT }),
    );
    expect(h.seqs.allocated).toEqual(['1']);
  });

  it('does not ask the door when the client offers channel-v1', async () => {
    const h = build(true);

    await h.calls.call(SESSION_B, TOOL, ARGS, {
      rail: PaymentRail.RAIL_B_VOUCHER,
      voucher: null,
      schemes: [CHANNEL_SCHEME],
    } as never);

    expect(h.channelAdmission.refusesPerCallOnly).not.toHaveBeenCalled();
  });

  it('leaves a chain that is not required on the per-call door', async () => {
    const h = build(false);

    const outcome = await h.calls.call(SESSION_B, TOOL, ARGS, {
      rail: PaymentRail.RAIL_B_VOUCHER,
      voucher: null,
    });

    if (outcome.kind !== 'ERROR') throw new Error('expected a payment requirement');
    expect(outcome.code).toBe(McpFailureCode.PAYMENT_REQUIRED);
    expect(h.seqs.allocated).toEqual(['1']);
  });

  it('leaves free calls untouched', async () => {
    const h = build(true, PricingMode.FREE);

    const outcome = await h.calls.call(SESSION_B, TOOL, ARGS);

    if (outcome.kind !== 'RESULT') throw new Error('expected a RESULT');
    expect(outcome.receipt.charged.amount).toBe('0');
    expect(h.channelAdmission.refusesPerCallOnly).not.toHaveBeenCalled();
  });
});
