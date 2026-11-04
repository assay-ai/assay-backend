import { Logger } from '@nestjs/common';

import { AccountId } from '@modules/chains/ports/caip.types';
import { McpErrorCode, McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { PaymentRail } from '@modules/payment/ports/payment.types';
import { SpendPolicyEnforcementService } from '@modules/spend-policy/services/spend-policy-enforcement.service';
import {
  VelocityViolation,
  VelocityViolationKind,
} from '@modules/spend-policy/services/spend-policy-velocity.service';
import { AppError } from '@shared/errors/app-errors';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  ScriptedInvoker,
  buildBinding,
  buildProvider,
  ok,
  usdc,
} from '../tool/helpers/routing-fixtures';
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

function build(spendPolicy?: unknown) {
  const invoker = new ScriptedInvoker({ 'binding-provider-a': async () => ok('1.08') });
  const admit = jest.fn(async () => {
    throw new Error('the channel door must not be reached');
  });
  const channelAdmission = {
    admit,
    requirement: jest.fn(async () => null),
    refusesPerCallOnly: async () => false,
  };
  const h = buildMcpHarness({
    bindings: [buildBinding('provider-a')],
    providers: [buildProvider('provider-a')],
    invoker,
    channelAdmission,
    ...(spendPolicy ? { spendPolicy: spendPolicy as never } : {}),
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

  /**
   * The same order with the REAL `SpendPolicyEnforcementService` (review L-6):
   * its own `assertCallAllowed` raises each code, inside its own lock, and the
   * door is still never reached. Its stores are stubbed; the decisions are its.
   */
  describe('with the real SpendPolicyEnforcementService', () => {
    const price = usdc('0.05');
    const basePolicy = {
      organizationId: SESSION.organizationId,
      agentId: null,
      policyVersion: 3,
      assetId: price.asset,
      decimals: price.decimals,
      perCallMax: null as string | null,
      dailyCap: null as string | null,
      monthlyCap: null as string | null,
      maxCallsPerHour: null,
      maxCallsPerMinute: null,
      maxSpendPerHour: null as string | null,
      requireApprovalAbove: null as string | null,
      paused: false,
    };

    function realPolicy(
      policy: Partial<typeof basePolicy>,
      options: { violation?: VelocityViolation; spent?: string; lockHeld?: boolean } = {},
    ) {
      const spent = MoneyUtil.of(options.spent ?? '0', price.asset, price.decimals);
      const velocity = {
        tryLockAgentSpend: jest.fn(async () => true),
        renewAgentSpendLock: jest.fn(async () => true),
        holdsAgentSpendLock: jest.fn(async () => options.lockHeld ?? true),
        unlockAgentSpend: jest.fn(async () => undefined),
        consume: jest.fn(async () => options.violation ?? null),
      };
      const service = new SpendPolicyEnforcementService(
        { findLive: async () => ({ ...basePolicy, ...policy }), insert: jest.fn() } as never,
        {
          spendSoFar: async () => ({
            spendToday: spent,
            spendThisMonth: spent,
            spendThisHour: spent,
          }),
        } as never,
        velocity as never,
        { notify: jest.fn(async () => undefined) } as never,
        { findById: jest.fn(async () => null) } as never,
      );
      return { service, velocity };
    }

    // Only this spy: the suite's rail spies (offerSolanaRailBInThisSuite) must stay.
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    const REAL: Array<
      [
        string,
        Partial<typeof basePolicy>,
        { violation?: VelocityViolation; spent?: string },
        McpErrorCode,
      ]
    > = [
      ['agent paused', { paused: true }, {}, McpErrorCode.MCP_POLICY_AGENT_PAUSED],
      ['per-call ceiling', { perCallMax: '1' }, {}, McpErrorCode.MCP_SPEND_LIMIT_EXCEEDED],
      ['approval threshold', { requireApprovalAbove: '1' }, {}, McpErrorCode.MCP_APPROVAL_REQUIRED],
      [
        'calls per minute',
        {},
        { violation: { kind: VelocityViolationKind.CALLS_PER_MINUTE, retryAfterSeconds: 30 } },
        McpErrorCode.MCP_VELOCITY_LIMIT_EXCEEDED,
      ],
      [
        'spend per hour',
        { maxSpendPerHour: '60000' },
        { spent: '20000' },
        McpErrorCode.MCP_VELOCITY_LIMIT_EXCEEDED,
      ],
      [
        'daily cap',
        { dailyCap: '60000' },
        { spent: '20000' },
        McpErrorCode.MCP_SPEND_LIMIT_EXCEEDED,
      ],
      [
        'monthly cap',
        { monthlyCap: '60000' },
        { spent: '20000' },
        McpErrorCode.MCP_SPEND_LIMIT_EXCEEDED,
      ],
    ];

    it.each(REAL)(
      '%s is refused by assertCallAllowed before ChannelAdmissionService.admit',
      async (_name, policy, options, code) => {
        const { service, velocity } = realPolicy(policy, options);
        const h = build(service);

        await expect(
          h.calls.call(SESSION_B, 'Search the web', ARGS, channelPayment),
        ).rejects.toMatchObject({ errorCode: code });

        expect(h.admit).not.toHaveBeenCalled();
        expect(h.intents.rows.size).toBe(0);
        // Inside the lock, and the lock was released.
        expect(velocity.tryLockAgentSpend).toHaveBeenCalledTimes(1);
        expect(velocity.unlockAgentSpend).toHaveBeenCalledTimes(1);
        // The lock-ownership check (the only post-store refusal) never ran.
        expect(velocity.holdsAgentSpendLock).not.toHaveBeenCalled();
      },
    );

    it('the control: a policy that admits the call lets it reach the channel door', async () => {
      const { service } = realPolicy({}, {});
      const h = build(service);

      await expect(h.calls.call(SESSION_B, 'Search the web', ARGS, channelPayment)).rejects.toThrow(
        'the channel door must not be reached',
      );
      expect(h.admit).toHaveBeenCalledTimes(1);
    });

    it('inside withAgentSpendLock only assertLockHeld refuses after the check, with UNAVAILABLE', async () => {
      const { service } = realPolicy({}, { lockHeld: false });
      // A section that never asks for the lock's ownership is never refused by the lock.
      await expect(service.withAgentSpendLock('agent', async () => 'done')).resolves.toBe('done');
      await expect(
        service.withAgentSpendLock('agent', async (assertLockHeld) => {
          await assertLockHeld();
          return 'stored';
        }),
      ).rejects.toMatchObject({
        errorCode: McpErrorCode.MCP_VELOCITY_LIMIT_EXCEEDED,
        context: expect.objectContaining({ reason: VelocityViolationKind.UNAVAILABLE }),
      });
    });
  });
});
