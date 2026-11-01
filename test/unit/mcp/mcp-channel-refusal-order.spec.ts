import { AccountId } from '@modules/chains/ports/caip.types';
import { McpErrorCode, McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { PaymentRail } from '@modules/payment/ports/payment.types';
import { VelocityViolationKind } from '@modules/spend-policy/services/spend-policy-velocity.service';
import { AppError } from '@shared/errors/app-errors';

import { ScriptedInvoker, buildBinding, buildProvider, ok } from '../tool/helpers/routing-fixtures';
import { offerSolanaRailBInThisSuite } from '../helpers/solana-rail-b';
import { CHAIN_ID, SESSION, buildMcpHarness } from './helpers/mcp-harness';

/**
 * BUG-R2-BUY-03 (investigation): every spend-policy refusal of a paid call on
 * the CHANNEL door is made by `assertCallAllowed`, inside the agent's spend
 * lock, BEFORE `ChannelAdmissionService.admit` runs — so before the voucher is
 * parsed, stored (`insertVoucher`) or the lane advanced (`advanceAccepted`).
 * A client may keep the lane and re-send the same position after such a
 * refusal. Pinned here by mechanism: the door is never reached.
 */
const AGENT: AccountId = `${CHAIN_ID}:Agent1111111111111111111111111111111111111` as AccountId;
const SESSION_B: McpSession = { ...SESSION, agentAccount: AGENT };
const ARGS = { query: 'usd eur' };

function build() {
  const invoker = new ScriptedInvoker({ 'binding-provider-a': async () => ok('1.08') });
  const admit = jest.fn(async () => {
    throw new Error('the channel door must not be reached');
  });
  const channelAdmission = { admit, requirement: jest.fn(async () => null) };
  const h = buildMcpHarness({
    bindings: [buildBinding('provider-a')],
    providers: [buildProvider('provider-a')],
    invoker,
    channelAdmission,
  });
  return { ...h, admit };
}

const channelPayment = {
  rail: PaymentRail.RAIL_B_VOUCHER,
  voucher: null,
  channel: {
    voucher: { cumulative: '10000', calls: 17 },
    signature: '0x00',
    providerId: 'provider-a',
  },
};

const REFUSALS: Array<[string, () => AppError]> = [
  [
    'DUPLICATE_REQUEST',
    () =>
      McpErrors.velocityLimitExceeded({
        reason: VelocityViolationKind.DUPLICATE_REQUEST,
        retryAfter: 19,
      }),
  ],
  [
    'CALLS_PER_MINUTE',
    () =>
      McpErrors.velocityLimitExceeded({
        reason: VelocityViolationKind.CALLS_PER_MINUTE,
        retryAfter: 30,
      }),
  ],
  [
    'CALLS_PER_HOUR',
    () =>
      McpErrors.velocityLimitExceeded({
        reason: VelocityViolationKind.CALLS_PER_HOUR,
        retryAfter: 600,
      }),
  ],
  [
    'SPEND_PER_HOUR',
    () =>
      McpErrors.velocityLimitExceeded({
        reason: VelocityViolationKind.SPEND_PER_HOUR,
        retryAfter: 600,
      }),
  ],
  ['spend limit (daily)', () => McpErrors.spendLimitExceeded({ limitType: 'daily' })],
  ['agent paused', () => McpErrors.policyAgentPaused({ agentId: 'agent' })],
  ['approval required', () => McpErrors.approvalRequired({ threshold: '1', asset: 'x' })],
];

describe('channel door: spend-policy refusals come before the voucher is stored (BUG-R2-BUY-03)', () => {
  offerSolanaRailBInThisSuite();

  it.each(REFUSALS)(
    '%s is refused before ChannelAdmissionService.admit',
    async (_name, refusal) => {
      const h = build();
      const error = refusal();
      h.spendPolicy.refuseWith = error;

      await expect(h.calls.call(SESSION_B, 'Search the web', ARGS, channelPayment)).rejects.toBe(
        error,
      );

      expect(h.spendPolicy.checked).toHaveLength(1);
      expect(h.admit).not.toHaveBeenCalled();
      expect(h.intents.rows.size).toBe(0);
    },
  );

  it('without a refusal the same call does reach the channel door (the control)', async () => {
    const h = build();

    await expect(h.calls.call(SESSION_B, 'Search the web', ARGS, channelPayment)).rejects.toThrow(
      'the channel door must not be reached',
    );
    expect(h.admit).toHaveBeenCalledTimes(1);
    expect(h.spendPolicy.uncheckedOutsideLock).toBe(0);
  });

  it('the velocity code alone does not say "before the store": UNAVAILABLE is also raised after it', () => {
    // `withAgentSpendLock`'s `assertLockHeld` (the door's `beforeHold`) runs
    // AFTER the voucher is stored and refuses with this same code and reason.
    expect(
      McpErrors.velocityLimitExceeded({ reason: VelocityViolationKind.UNAVAILABLE }).errorCode,
    ).toBe(McpErrorCode.MCP_VELOCITY_LIMIT_EXCEEDED);
  });
});
