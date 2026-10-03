import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { SpendPolicyEntity } from '@database/postgres/entities/spend-policy.entity';
import { SpendPolicyRepository } from '@database/postgres/repositories/spend-policy.repository';
import { McpErrorCode } from '@modules/mcp/errors/mcp.errors';
import { NotificationEvent, NotificationPort } from '@modules/notification/ports/notification.port';
import {
  AssertCallAllowedInput,
  SpendPolicyEnforcementService,
} from '@modules/spend-policy/services/spend-policy-enforcement.service';
import {
  SpendUsageService,
  AgentSpendUsage,
} from '@modules/spend-policy/services/spend-usage.service';
import {
  SpendPolicyVelocityService,
  VelocityViolation,
  VelocityViolationKind,
} from '@modules/spend-policy/services/spend-policy-velocity.service';
import { BaseError } from '@shared/errors/base.error';
import { AppError } from '@shared/errors/app-errors';

const ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;
const DECIMALS = 6;
const ORG = 'org-1';
const AGENT = 'agent-1';
const TOOL = 'tool-1';
const HASH = 'sha256:' + 'a'.repeat(64);

function money(amount: string): Money {
  return { amount, asset: ASSET, decimals: DECIMALS };
}

function policyRow(overrides: Partial<SpendPolicyEntity> = {}): SpendPolicyEntity {
  return {
    id: 'policy-1',
    organizationId: ORG,
    agentId: null,
    policyVersion: 3,
    assetId: ASSET,
    decimals: DECIMALS,
    perCallMax: '500000',
    dailyCap: '10000000',
    monthlyCap: '100000000',
    maxCallsPerHour: null,
    maxCallsPerMinute: 60,
    maxSpendPerHour: '5000000',
    allowedTools: null,
    requireApprovalAbove: '2000000',
    paused: false,
    changedBy: 'system',
    changeReason: null,
    supersededAt: null,
    createdAt: new Date('2026-08-07T09:14:00.000Z'),
    updatedAt: new Date('2026-08-07T09:14:00.000Z'),
    ...overrides,
  } as unknown as SpendPolicyEntity;
}

function zeroUsage(): AgentSpendUsage {
  return { spendToday: money('0'), spendThisMonth: money('0') };
}

function build(options: {
  findLive?: jest.Mock;
  insert?: jest.Mock;
  spendSoFar?: jest.Mock;
  consume?: jest.Mock;
  notify?: jest.Mock;
}) {
  const policies = {
    findLive: options.findLive ?? jest.fn().mockResolvedValue(policyRow()),
    insert: options.insert ?? jest.fn().mockResolvedValue({ identifiers: [{ id: 'seeded' }] }),
  } as unknown as SpendPolicyRepository;

  const usage = {
    spendSoFar: options.spendSoFar ?? jest.fn().mockResolvedValue(zeroUsage()),
  } as unknown as SpendUsageService;

  const velocity = {
    consume: options.consume ?? jest.fn().mockResolvedValue(null),
    read: jest.fn(),
  } as unknown as SpendPolicyVelocityService;

  const notify = options.notify ?? jest.fn().mockResolvedValue(undefined);
  const notifications: NotificationPort = { notify };

  const service = new SpendPolicyEnforcementService(policies, usage, velocity, notifications);
  return { service, policies, usage, velocity, notify };
}

function input(overrides: Partial<AssertCallAllowedInput> = {}): AssertCallAllowedInput {
  return {
    organizationId: ORG,
    agentId: AGENT,
    toolId: TOOL,
    price: money('100000'),
    requestHash: HASH,
    ...overrides,
  };
}

async function errorCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return (error as BaseError).errorCode;
  }
  throw new Error('expected a throw, got none');
}

async function contextOf(fn: () => Promise<unknown>): Promise<Record<string, unknown> | undefined> {
  try {
    await fn();
  } catch (error) {
    return (error as AppError).context;
  }
  throw new Error('expected a throw, got none');
}

describe('SpendPolicyEnforcementService.assertCallAllowed — order and pause', () => {
  it('1. paused refuses with MCP_POLICY_AGENT_PAUSED and does not touch usage or velocity', async () => {
    const { service, usage, velocity } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ paused: true })),
    });

    const code = await errorCodeOf(() => service.assertCallAllowed(input()));

    expect(code).toBe(McpErrorCode.MCP_POLICY_AGENT_PAUSED);
    // A refused call holds no money: nothing downstream of the pause check ran.
    expect(usage.spendSoFar).not.toHaveBeenCalled();
    expect(velocity.consume).not.toHaveBeenCalled();
  });
});

describe('SpendPolicyEnforcementService.assertCallAllowed — allowlist', () => {
  it('2. refuses a tool not on the allowlist with MCP_TOOL_NOT_ALLOWED', async () => {
    const { service, velocity } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ allowedTools: ['other-tool'] })),
    });

    const code = await errorCodeOf(() => service.assertCallAllowed(input({ toolId: TOOL })));

    expect(code).toBe(McpErrorCode.MCP_TOOL_NOT_ALLOWED);
    expect(velocity.consume).not.toHaveBeenCalled();
  });

  it('permits a tool that is on the allowlist', async () => {
    const { service } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ allowedTools: [TOOL, 'other-tool'] })),
    });

    await expect(service.assertCallAllowed(input({ toolId: TOOL }))).resolves.toBe(3);
  });

  it('null allowedTools means every tool is permitted', async () => {
    const { service } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ allowedTools: null })),
    });

    await expect(service.assertCallAllowed(input())).resolves.toBe(3);
  });
});

describe('SpendPolicyEnforcementService.assertCallAllowed — per-call ceiling', () => {
  it('3. permits a call exactly at the ceiling and refuses one unit above it', async () => {
    const { service } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ perCallMax: '500000' })),
    });

    await expect(service.assertCallAllowed(input({ price: money('500000') }))).resolves.toBe(3);

    const code = await errorCodeOf(() =>
      service.assertCallAllowed(input({ price: money('500001') })),
    );
    expect(code).toBe(McpErrorCode.MCP_SPEND_LIMIT_EXCEEDED);
  });
});

describe('SpendPolicyEnforcementService.assertCallAllowed — velocity', () => {
  it('4. propagates a velocity violation as MCP_VELOCITY_LIMIT_EXCEEDED, carrying retryAfter', async () => {
    const violation: VelocityViolation = {
      kind: VelocityViolationKind.CALLS_PER_MINUTE,
      retryAfterSeconds: 42,
    };
    const { service } = build({ consume: jest.fn().mockResolvedValue(violation) });

    const context = await contextOf(() => service.assertCallAllowed(input()));

    expect(context?.retryAfter).toBe(42);
    expect(context?.reason).toBe(VelocityViolationKind.CALLS_PER_MINUTE);
  });

  it('does not reach the daily/monthly cap query when velocity already refused', async () => {
    const violation: VelocityViolation = {
      kind: VelocityViolationKind.SPEND_PER_HOUR,
      retryAfterSeconds: 10,
    };
    const { service, usage } = build({ consume: jest.fn().mockResolvedValue(violation) });

    await expect(service.assertCallAllowed(input())).rejects.toBeInstanceOf(BaseError);
    expect(usage.spendSoFar).not.toHaveBeenCalled();
  });

  it('Redis-unavailable fails CLOSED: UNAVAILABLE is treated as a real refusal, not permitted', async () => {
    const violation: VelocityViolation = {
      kind: VelocityViolationKind.UNAVAILABLE,
      retryAfterSeconds: 5,
    };
    const { service } = build({ consume: jest.fn().mockResolvedValue(violation) });

    const code = await errorCodeOf(() => service.assertCallAllowed(input()));
    expect(code).toBe(McpErrorCode.MCP_VELOCITY_LIMIT_EXCEEDED);
  });

  it('notifies velocity.anomaly only when the violation is a fresh duplicate-request anomaly', async () => {
    const fresh: VelocityViolation = {
      kind: VelocityViolationKind.DUPLICATE_REQUEST,
      retryAfterSeconds: 30,
      freshAnomaly: true,
    };
    const { service, notify } = build({ consume: jest.fn().mockResolvedValue(fresh) });

    await expect(service.assertCallAllowed(input())).rejects.toBeInstanceOf(BaseError);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ event: NotificationEvent.VELOCITY_ANOMALY }),
    );
  });

  it('does not re-notify a duplicate-request anomaly that is already suppressed for the incident', async () => {
    const suppressed: VelocityViolation = {
      kind: VelocityViolationKind.DUPLICATE_REQUEST,
      retryAfterSeconds: 30,
      freshAnomaly: false,
    };
    const { service, notify } = build({ consume: jest.fn().mockResolvedValue(suppressed) });

    await expect(service.assertCallAllowed(input())).rejects.toBeInstanceOf(BaseError);

    expect(notify).not.toHaveBeenCalled();
  });
});

describe('SpendPolicyEnforcementService.assertCallAllowed — daily / monthly caps', () => {
  it('5. permits spend that lands exactly on the daily cap and refuses one unit past it, carrying resetsAt', async () => {
    const { service } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ dailyCap: '1000000', monthlyCap: null })),
      spendSoFar: jest.fn().mockResolvedValue({
        spendToday: money('900000'),
        spendThisMonth: money('900000'),
      }),
    });

    await expect(
      service.assertCallAllowed(input({ price: money('100000') })), // exactly at the cap
    ).resolves.toBe(3);

    const { service: service2 } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ dailyCap: '1000000', monthlyCap: null })),
      spendSoFar: jest.fn().mockResolvedValue({
        spendToday: money('900001'),
        spendThisMonth: money('900001'),
      }),
    });

    const context = await contextOf(() =>
      service2.assertCallAllowed(input({ price: money('100000') })),
    );
    expect(context?.limitType).toBe('daily');
    expect(context?.resetsAt).toEqual(expect.any(String));
  });

  it('checks the monthly cap independently of the daily cap', async () => {
    const { service } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ dailyCap: null, monthlyCap: '1000000' })),
      spendSoFar: jest.fn().mockResolvedValue({
        spendToday: money('0'),
        spendThisMonth: money('999999'),
      }),
    });

    const context = await contextOf(() => service.assertCallAllowed(input({ price: money('2') })));
    expect(context?.limitType).toBe('monthly');
  });
});

describe('SpendPolicyEnforcementService.assertCallAllowed — alert bands (never blocks)', () => {
  it('notifies spend.threshold_crossed at 80% and still permits the call', async () => {
    const { service, notify } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ dailyCap: '1000000', monthlyCap: null })),
      spendSoFar: jest.fn().mockResolvedValue({
        spendToday: money('750000'), // 75% before this call
        spendThisMonth: money('750000'),
      }),
    });

    // +50000 crosses 80% (800000) without exceeding the cap.
    const version = await service.assertCallAllowed(input({ price: money('50000') }));

    expect(version).toBe(3);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        event: NotificationEvent.SPEND_THRESHOLD_CROSSED,
        dedupeKey: `${AGENT}:daily:80`,
      }),
    );
  });

  it('does not notify a band that was already crossed before this call', async () => {
    const { service, notify } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ dailyCap: '1000000', monthlyCap: null })),
      spendSoFar: jest.fn().mockResolvedValue({
        spendToday: money('850000'), // already past 80%
        spendThisMonth: money('850000'),
      }),
    });

    await service.assertCallAllowed(input({ price: money('1000') }));

    expect(notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: `${AGENT}:daily:80` }),
    );
  });

  it('a notification failure never turns an otherwise-successful call into an error', async () => {
    const { service } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ dailyCap: '1000000', monthlyCap: null })),
      spendSoFar: jest.fn().mockResolvedValue({
        spendToday: money('750000'),
        spendThisMonth: money('750000'),
      }),
      notify: jest.fn().mockRejectedValue(new Error('notification sink is down')),
    });

    await expect(service.assertCallAllowed(input({ price: money('50000') }))).resolves.toBe(3);
  });
});

describe('SpendPolicyEnforcementService.assertCallAllowed — no policy exists', () => {
  it('seeds the organization default spend limits and enforces against them', async () => {
    const seeded = policyRow({ policyVersion: 1, dailyCap: '1000000' });
    const findLive = jest
      .fn()
      .mockResolvedValueOnce(null) // first resolution attempt: nothing exists
      .mockResolvedValueOnce(seeded); // re-read after the seed insert
    const insert = jest.fn().mockResolvedValue({ identifiers: [{ id: 'seeded' }] });

    const { service } = build({ findLive, insert });

    const version = await service.assertCallAllowed(input({ price: money('1000') }));

    expect(version).toBe(1);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        agentId: null,
        policyVersion: 1,
        assetId: ASSET,
        decimals: DECIMALS,
        // $0.50 at 6 decimals = 500000 atomic units.
        perCallMax: '500000',
        dailyCap: '10000000',
        monthlyCap: '100000000',
        maxCallsPerMinute: 60,
        maxCallsPerHour: null,
        maxSpendPerHour: '5000000',
        changedBy: 'system:g27a-auto-seed',
      }),
    );
  });

  it('a lost seed race (unique violation) re-reads instead of failing the call', async () => {
    const winnerRow = policyRow({ policyVersion: 1 });
    const findLive = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winnerRow);
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    const insert = jest.fn().mockRejectedValue(uniqueViolation);

    const { service } = build({ findLive, insert });

    await expect(service.assertCallAllowed(input())).resolves.toBe(1);
  });

  it('permits the call ungoverned (policyVersion null) when seeding fails for any other reason', async () => {
    const findLive = jest.fn().mockResolvedValue(null);
    const insert = jest.fn().mockRejectedValue(new Error('database is unreachable'));

    const { service } = build({ findLive, insert });

    await expect(service.assertCallAllowed(input())).resolves.toBeNull();
  });
});

describe('SpendPolicyEnforcementService.assertCallAllowed — asset mismatch', () => {
  it('skips every money-based check when the call is priced in a different asset than the policy', async () => {
    const { service, usage } = build({
      findLive: jest.fn().mockResolvedValue(
        policyRow({ perCallMax: '1', dailyCap: '1', monthlyCap: '1' }), // would refuse any real amount
      ),
    });

    const otherAsset = 'solana:testnet/token:SomeOtherMint111111111111111111111111111' as AssetId;
    const version = await service.assertCallAllowed(
      input({ price: { amount: '999999999', asset: otherAsset, decimals: DECIMALS } }),
    );

    expect(version).toBe(3);
    expect(usage.spendSoFar).not.toHaveBeenCalled();
  });
});
