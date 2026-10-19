import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { SpendPolicyEntity } from '@database/postgres/entities/spend-policy.entity';
import { SpendPolicyRepository } from '@database/postgres/repositories/spend-policy.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
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
    accessMode: 'ALL',
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

/** The band notices are fired without awaiting; let them land. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function zeroUsage(): AgentSpendUsage {
  return { spendThisHour: money('0'), spendToday: money('0'), spendThisMonth: money('0') };
}

function build(options: {
  findLive?: jest.Mock;
  insert?: jest.Mock;
  spendSoFar?: jest.Mock;
  consume?: jest.Mock;
  notify?: jest.Mock;
  findAgent?: jest.Mock;
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

  const findAgent = options.findAgent ?? jest.fn().mockResolvedValue({ label: 'research-bot' });
  const agents = { findOne: findAgent } as unknown as AgentRepository;

  const service = new SpendPolicyEnforcementService(
    policies,
    usage,
    velocity,
    notifications,
    agents,
  );
  return { service, policies, usage, velocity, notify, findAgent };
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

describe('SpendPolicyEnforcementService.assertCallAllowed — which tools', () => {
  // The access policy decides which tools an agent may call, before a call is
  // priced (`AccessResolver`); this gate only weighs money, so a RESTRICTED row
  // changes nothing here.
  it('does not refuse a call on the access policy, which is enforced earlier', async () => {
    const { service } = build({
      findLive: jest
        .fn()
        .mockResolvedValue(policyRow({ accessMode: 'RESTRICTED', allowedToolIds: [] })),
    });

    await expect(service.assertCallAllowed(input({ toolId: TOOL }))).resolves.toBe(3);
  });
});

describe('SpendPolicyEnforcementService.assertCallAllowed — approval threshold', () => {
  it('3b. permits a call at the threshold and refuses one above it, before velocity', async () => {
    const { service, velocity } = build({
      findLive: jest
        .fn()
        .mockResolvedValue(policyRow({ perCallMax: null, requireApprovalAbove: '2000000' })),
    });

    await expect(service.assertCallAllowed(input({ price: money('2000000') }))).resolves.toBe(3);
    (velocity.consume as jest.Mock).mockClear();

    const code = await errorCodeOf(() =>
      service.assertCallAllowed(input({ price: money('2000001') })),
    );

    expect(code).toBe(McpErrorCode.MCP_APPROVAL_REQUIRED);
    expect(velocity.consume).not.toHaveBeenCalled();
  });

  it('a null threshold never asks for approval', async () => {
    const { service } = build({
      findLive: jest
        .fn()
        .mockResolvedValue(
          policyRow({ perCallMax: null, requireApprovalAbove: null, maxSpendPerHour: null }),
        ),
    });

    await expect(service.assertCallAllowed(input({ price: money('9000000') }))).resolves.toBe(3);
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

  it('names the agent by its label in the velocity notice, never its id', async () => {
    const fresh: VelocityViolation = {
      kind: VelocityViolationKind.DUPLICATE_REQUEST,
      retryAfterSeconds: 30,
      freshAnomaly: true,
    };
    const { service, notify, findAgent } = build({ consume: jest.fn().mockResolvedValue(fresh) });

    await expect(service.assertCallAllowed(input())).rejects.toBeInstanceOf(BaseError);

    expect(findAgent).toHaveBeenCalledWith({ where: { id: AGENT, organizationId: ORG } });
    const body = notify.mock.calls[0][0].body as string;
    expect(body).toBe(
      '"research-bot" sent the same request repeatedly in a short window and has been throttled.',
    );
    expect(body).not.toContain(AGENT);
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

describe('SpendPolicyEnforcementService.assertCallAllowed — spend/hour', () => {
  // Spend/hour is read from the same spend-counting intents as the daily cap
  // (open holds + SETTLED), not from a counter bumped on every attempt: a call
  // that was voided or refunded never reaches `spendThisHour`, so it cannot
  // lock the agent out. The Redis layer only counts attempts.
  const hourlyOnly = policyRow({
    dailyCap: null,
    monthlyCap: null,
    maxSpendPerHour: '5000000',
  });

  it('permits a call when the hour so far holds only voided calls (spendThisHour is 0)', async () => {
    const { service, velocity } = build({
      findLive: jest.fn().mockResolvedValue(hourlyOnly),
      spendSoFar: jest.fn().mockResolvedValue(zeroUsage()),
    });

    await expect(service.assertCallAllowed(input({ price: money('100000') }))).resolves.toBe(3);
    // The attempt counters get no money limit — spend is not theirs to track.
    expect(velocity.consume).toHaveBeenCalledWith(
      AGENT,
      HASH,
      expect.not.objectContaining({ maxSpendPerHour: expect.anything() }),
    );
  });

  it('refuses with SPEND_PER_HOUR when settled/held spend this hour plus this call exceeds the ceiling', async () => {
    const { service } = build({
      findLive: jest.fn().mockResolvedValue(hourlyOnly),
      spendSoFar: jest.fn().mockResolvedValue({
        spendThisHour: money('4950000'),
        spendToday: money('4950000'),
        spendThisMonth: money('4950000'),
      }),
    });

    const context = await contextOf(() =>
      service.assertCallAllowed(input({ price: money('100000') })),
    );
    expect(context?.reason).toBe(VelocityViolationKind.SPEND_PER_HOUR);
    expect(context?.retryAfter).toEqual(expect.any(Number));
  });

  it('permits spend that lands exactly on the hourly ceiling', async () => {
    const { service } = build({
      findLive: jest.fn().mockResolvedValue(hourlyOnly),
      spendSoFar: jest.fn().mockResolvedValue({
        spendThisHour: money('4900000'),
        spendToday: money('4900000'),
        spendThisMonth: money('4900000'),
      }),
    });

    await expect(service.assertCallAllowed(input({ price: money('100000') }))).resolves.toBe(3);
  });
});

describe('SpendPolicyEnforcementService.assertCallAllowed — daily / monthly caps', () => {
  it('5. permits spend that lands exactly on the daily cap and refuses one unit past it, carrying resetsAt', async () => {
    const { service } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ dailyCap: '1000000', monthlyCap: null })),
      spendSoFar: jest.fn().mockResolvedValue({
        spendThisHour: money('0'),
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
        spendThisHour: money('0'),
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
        spendThisHour: money('0'),
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
        spendThisHour: money('0'),
        spendToday: money('750000'), // 75% before this call
        spendThisMonth: money('750000'),
      }),
    });

    // +50000 crosses 80% (800000) without exceeding the cap.
    const version = await service.assertCallAllowed(input({ price: money('50000') }));
    await flushMicrotasks();

    expect(version).toBe(3);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        event: NotificationEvent.SPEND_THRESHOLD_CROSSED,
        dedupeKey: `${AGENT}:daily:80`,
      }),
    );
  });

  it('writes the band notice with the agent label and dollar amounts', async () => {
    const { service, notify } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ dailyCap: '5000000', monthlyCap: null })),
      spendSoFar: jest.fn().mockResolvedValue({
        spendThisHour: money('0'),
        spendToday: money('4900000'),
        spendThisMonth: money('4900000'),
      }),
    });

    await service.assertCallAllowed(input({ price: money('100000') }));
    await flushMicrotasks();

    const band = notify.mock.calls.find((call) => call[0].dedupeKey === `${AGENT}:daily:100`)?.[0];
    expect(band?.body).toBe('"research-bot" has spent $5.00 of its $5.00 daily limit (100%).');
    // The payload keeps the exact figures and the asset for anything that needs them.
    expect(band?.payload).toEqual(
      expect.objectContaining({ scope: 'daily', band: 100, cap: '5000000', spendAfter: '5000000' }),
    );
  });

  it('says "Your agent" when the label cannot be read, and still notifies', async () => {
    const { service, notify } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ dailyCap: '1000000', monthlyCap: null })),
      spendSoFar: jest.fn().mockResolvedValue({
        spendThisHour: money('0'),
        spendToday: money('750000'),
        spendThisMonth: money('750000'),
      }),
      findAgent: jest.fn().mockRejectedValue(new Error('db down')),
    });

    await expect(service.assertCallAllowed(input({ price: money('50000') }))).resolves.toBe(3);
    await flushMicrotasks();

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: `${AGENT}:daily:80`,
        body: 'Your agent has spent $0.80 of its $1.00 daily limit (80%).',
      }),
    );
  });

  it('does not notify a band that was already crossed before this call', async () => {
    const { service, notify } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ dailyCap: '1000000', monthlyCap: null })),
      spendSoFar: jest.fn().mockResolvedValue({
        spendThisHour: money('0'),
        spendToday: money('850000'), // already past 80%
        spendThisMonth: money('850000'),
      }),
    });

    await service.assertCallAllowed(input({ price: money('1000') }));
    await flushMicrotasks();

    expect(notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: `${AGENT}:daily:80` }),
    );
  });

  it('a notification failure never turns an otherwise-successful call into an error', async () => {
    const { service } = build({
      findLive: jest.fn().mockResolvedValue(policyRow({ dailyCap: '1000000', monthlyCap: null })),
      spendSoFar: jest.fn().mockResolvedValue({
        spendThisHour: money('0'),
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
  /**
   * REGRESSION (review 2026-10-15 P-9): a call priced in another asset used to
   * skip every money check, so a typo in the policy's asset switched off every
   * cap while the policy screen still showed them. It is refused instead.
   */
  it('refuses a call priced in a different asset than the policy, before velocity', async () => {
    const { service, usage, velocity } = build({
      findLive: jest.fn().mockResolvedValue(
        policyRow({ perCallMax: '1', dailyCap: '1', monthlyCap: '1' }), // would refuse any real amount
      ),
    });

    const otherAsset = 'solana:testnet/token:SomeOtherMint111111111111111111111111111' as AssetId;
    await expect(
      service.assertCallAllowed(
        input({ price: { amount: '999999999', asset: otherAsset, decimals: DECIMALS } }),
      ),
    ).rejects.toMatchObject({
      errorCode: McpErrorCode.MCP_SPEND_LIMIT_EXCEEDED,
      context: { limitType: 'asset_mismatch' },
    });

    expect(usage.spendSoFar).not.toHaveBeenCalled();
    expect(velocity.consume).not.toHaveBeenCalled();
  });
});
