import { getAddress, keccak256, toBytes } from 'viem';

import { VoucherChannelStatus } from '@database/postgres/entities/voucher-channel.entity';
import {
  CHANNEL_DROP_CONFIRM_SECONDS,
  DropWatch,
  droppedByNonce,
} from '@modules/payment/services/channel-tx-attempts';
import {
  terminalTimeoutRefusal,
  TERMINAL_TIMEOUT_MARGIN_SECONDS,
  loadChannelPolicy,
} from '@modules/payment/constants/channel.constants';
import {
  classifyLapse,
  DEFAULT_CHANNEL_POLICY,
  NO_BUCKET_DISPUTE_KEPT,
  placeCharge,
} from '@modules/payment/domain/channel/channel-policy';
import {
  channelRefundId,
  EMPTY_SLOT,
  REFUND_SKIP_REASONS,
  SETTLE_SKIP_REASONS,
} from '@modules/payment/domain/channel/channel-voucher';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import {
  ChannelSettlementService,
  fairDeadlineOrder,
} from '@modules/payment/services/channel-settlement.service';

/**
 * The 2026-11-01 security audit's repro tests (business B-1, B-2; backend
 * B-L2, B-S1; chain M-1), ported from
 * `e2e/backlog/round2-gas/scratch/sec-audit/` and turned around: each
 * reproduced the weakness, it now proves the fix.
 */

const CHAIN = 'eip155:46630';
const ASSET = `${CHAIN}/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac`;
const PAYER = getAddress(`0x${'aa'.repeat(20)}`);
const PROVIDER = getAddress(`0x${'bb'.repeat(20)}`);
const NOW = 1_800_000_000; // on the hour grid
const HOUR = NOW / 3_600;

function lane(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lane-1',
    chainId: CHAIN,
    assetId: ASSET,
    payer: `${CHAIN}:${PAYER}`,
    signer: `${CHAIN}:${PAYER}`,
    providerAccount: `${CHAIN}:${PROVIDER}`,
    providerId: 'provider-1',
    channelId: `0x${'5a'.repeat(32)}`,
    channelKey: `0x${'0c'.repeat(32)}`,
    status: VoucherChannelStatus.OPEN,
    statusReason: null,
    lastAcceptedCumulative: '300',
    lastAcceptedCalls: 3,
    settledCumulative: '100',
    settledCalls: 1,
    settlingTo: null,
    signerValidUntil: null,
    deadlineAt: null,
    urgentRequestedAt: null,
    ...overrides,
  };
}

function call(cumulative: bigint, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org',
    intentId: `i${cumulative}`,
    status: 'SETTLED',
    cumulative,
    calls: Number(cumulative / 100n),
    price: 100n,
    holdOpen: true,
    heldStatus: null,
    disputeOutcome: null,
    collectableAt: null,
    createdAt: new Date((NOW - 60) * 1000),
    settlementId: null,
    lapsed: false,
    ...overrides,
  };
}

/** A matured bucket kept by a dispute, from the audit (post-collect: A = 20, B = 30, both matured). */
const AFTER_COLLECT = {
  ...EMPTY_SLOT,
  settled: 100n,
  h1: 20n,
  m1: HOUR - 2,
  r1: 1_000,
  h2: 30n,
  m2: HOUR - 1,
  r2: 1_000,
};
/** The call whose dispute keeps money in bucket A. */
const DISPUTED = call(50n, {
  intentId: 'i-disputed',
  cumulative: 50n,
  heldStatus: 'HELD',
  disputeOutcome: 'OPEN',
  collectableAt: new Date((NOW - 3_600) * 1000),
});
const DEAD_VOUCHER = [
  {
    id: 'v3',
    cumulative: '300',
    calls: 3,
    issuedAt: String(NOW - 8_000),
    expiresAt: String(NOW - 7_300),
    signature: `0x${'11'.repeat(65)}`,
  },
];

function build(options: { lanes?: any[]; calls?: any[]; slot?: any; vouchers?: any[] }) {
  const statuses: { id: string; status: string; reason: string }[] = [];
  const skips: { id: string; reason: string | null }[] = [];
  const closedCalls: { id: string; ids: string[]; mark: string }[] = [];
  const lapsedCalls: { id: string; ids: string[]; cause: string }[] = [];
  const sent: string[] = [];
  const channels = {
    manager: { transaction: async (fn: any) => fn({}) },
    findInFlight: async () => [],
    listActive: async () => options.lanes ?? [lane()],
    calls: async () => options.calls ?? [],
    vouchers: async () =>
      options.vouchers ?? [
        {
          id: 'v3',
          cumulative: '300',
          calls: 3,
          issuedAt: String(NOW - 30),
          expiresAt: String(NOW + 200),
          signature: `0x${'11'.repeat(65)}`,
        },
      ],
    cadenceOf: async () => new Map(),
    setDeadline: async () => undefined,
    clearUrgent: async () => undefined,
    bindSettlement: async () => 'settlement-1',
    markSent: async () => undefined,
    releaseSettlement: async () => undefined,
    findReleasedTo: async () => null,
    releasedTo: async () => [],
    findInFlightTxs: async () => [],
    findUnbookedCollects: async () => [],
    insertTx: async () => 'tx-1',
    appendTxRef: async () => undefined,
    finishTx: async () => undefined,
    recordUnpaid: async () => undefined,
    setLastSkip: async (id: string, reason: string | null) => void skips.push({ id, reason }),
    closeUnsettled: async (id: string, ids: string[], mark: string) => {
      closedCalls.push({ id, ids, mark });
      return ids.map((i) => ({ organizationId: 'org', intentId: i, holdId: `h-${i}` }));
    },
    claimRequests: async () => [],
    setStatus: async (id: string, status: string, reason: string) =>
      void statuses.push({ id, status, reason }),
    lapse: async (id: string, ids: string[], cause: string) => {
      lapsedCalls.push({ id, ids, cause });
      return ids.length;
    },
    closeIdle: async () => 0,
  };
  const intents = {
    resolve: jest.fn(async () => undefined),
    findById: jest.fn(async () => ({ price: { amount: '100', asset: ASSET, decimals: 6 } })),
    releaseHold: jest.fn(),
  };
  const door = {
    doorLive: async () => true,
    txReceipt: async () => ({ state: 'UNKNOWN' }),
    signerWindow: async () => ({
      validUntil: null,
      revoked: false,
      revokeGraceEndsAt: null,
      heldCapsEndAt: null,
    }),
    providerRisk: async () => ({
      unbonding: false,
      slashPending: false,
      nearFloor: false,
      blocked: false,
    }),
    chainNow: async () => NOW,
    collectHoldSeconds: async () => 3_600,
    takeRateBps: async () => 1_000,
    readBooks: async () => ({
      slot: options.slot ?? { ...EMPTY_SLOT, settled: 100n },
      unpaid: 0n,
      totalUnpaid: 0n,
      held: 0n,
    }),
    simulateSettle: async () => [],
    settle: async () => {
      sent.push('settle');
      throw new Error('not expected');
    },
    collect: async () => {
      sent.push('collect');
      throw new Error('not expected');
    },
  };
  const service = new ChannelSettlementService(
    channels as never,
    intents as never,
    door as never,
    { emit: async () => undefined } as never,
    new Set([CHAIN]),
    DEFAULT_CHANNEL_POLICY,
    null,
    () => NOW * 1000,
  );
  return { service, statuses, skips, closedCalls, lapsedCalls, intents, sent };
}

describe('B-1 (High): a dispute-kept bucket forcing NoBucket makes the lapse buyer debt', () => {
  it('pure rule: the dispute-kept NoBucket is the buyer’s; a plain NoBucket stays the platform’s', () => {
    expect(placeCharge(AFTER_COLLECT, NOW, 3_600, 1_000, 200n)).toBe('NO_BUCKET');
    expect(classifyLapse(NO_BUCKET_DISPUTE_KEPT)).toBe('BUYER');
    expect(classifyLapse('NoBucket')).toBe('PLATFORM');
  });

  it('round: NO_BUCKET with a dispute-kept bucket records the dispute reason (not plain NoBucket)', async () => {
    const h = build({
      slot: AFTER_COLLECT,
      calls: [DISPUTED, call(200n, { createdAt: new Date((NOW - 1_800) * 1000) }), call(300n)],
    });
    await h.service.run(ASSET as never);
    expect(h.sent).toEqual([]);
    expect(h.statuses).toContainEqual({
      id: 'lane-1',
      status: VoucherChannelStatus.ROTATED,
      reason: 'NO_BUCKET',
    });
    expect(h.skips).toContainEqual({ id: 'lane-1', reason: NO_BUCKET_DISPUTE_KEPT });
  });

  it('round: NO_BUCKET with no dispute keep (a rate change) still records plain NoBucket', async () => {
    const h = build({
      slot: AFTER_COLLECT,
      calls: [call(200n, { createdAt: new Date((NOW - 1_800) * 1000) }), call(300n)],
    });
    await h.service.run(ASSET as never);
    expect(h.skips).toContainEqual({ id: 'lane-1', reason: 'NoBucket' });
  });

  it('later pass: the served calls of a dispute NoBucket lane become buyer DEBT, holds kept', async () => {
    const h = build({
      lanes: [
        lane({ status: VoucherChannelStatus.ROTATED, lastSkipReason: NO_BUCKET_DISPUTE_KEPT }),
      ],
      slot: AFTER_COLLECT,
      calls: [call(200n), call(300n)],
      vouchers: DEAD_VOUCHER,
    });
    await h.service.run(ASSET as never);
    expect(h.closedCalls).toEqual([]);
    expect(h.lapsedCalls).toEqual([
      {
        id: 'lane-1',
        ids: ['i200', 'i300'],
        cause: `ChannelVoucherExpired:${NO_BUCKET_DISPUTE_KEPT}`,
      },
    ]);
    expect(h.intents.releaseHold).not.toHaveBeenCalled();
  });

  it('later pass: a plain NoBucket recorded while a dispute still keeps a bucket is debt too', async () => {
    const h = build({
      lanes: [lane({ status: VoucherChannelStatus.ROTATED, lastSkipReason: 'NoBucket' })],
      slot: AFTER_COLLECT,
      calls: [DISPUTED, call(200n), call(300n)],
      vouchers: DEAD_VOUCHER,
    });
    await h.service.run(ASSET as never);
    expect(h.closedCalls).toEqual([]);
    expect(h.lapsedCalls[0]?.ids).toEqual(['i200', 'i300']);
  });

  it('control: a plain NoBucket with no dispute keep is still voided (owner rule: else → void)', async () => {
    const h = build({
      lanes: [lane({ status: VoucherChannelStatus.ROTATED, lastSkipReason: 'NoBucket' })],
      slot: AFTER_COLLECT,
      calls: [call(200n), call(300n)],
      vouchers: DEAD_VOUCHER,
    });
    await h.service.run(ASSET as never);
    expect(h.lapsedCalls).toEqual([]);
    expect(h.closedCalls[0]?.mark).toMatch(/^voided:CHANNEL_NoBucket/);
  });
});

describe('B-2: a renewed debt that dies unsettled again stays buyer debt', () => {
  for (const reason of ['SEND_FAILED', 'DEFERRED', 'NoBucket', 'Calls', null]) {
    it(`last skip ${reason ?? 'none'} (platform class): REPLACING rows lapse into debt again, never voided`, async () => {
      const h = build({
        lanes: [lane({ lastSkipReason: reason })],
        // REPLACING rows: lapsed=false (replaced_at set) but they were debt once.
        calls: [
          call(200n, { lapsed: false, everLapsed: true }),
          call(300n, { lapsed: false, everLapsed: true }),
        ],
        vouchers: DEAD_VOUCHER,
      });
      await h.service.run(ASSET as never);
      expect(h.closedCalls).toEqual([]);
      expect(h.lapsedCalls).toEqual([
        {
          id: 'lane-1',
          ids: ['i200', 'i300'],
          cause: `ChannelVoucherExpired:RELAPSE:${reason ?? 'unknown'}`,
        },
      ]);
    });
  }

  it('a provider-side cause still forfeits a renewed debt (the provider’s fault)', async () => {
    const h = build({
      lanes: [lane({ lastSkipReason: 'Stake' })],
      calls: [call(200n, { everLapsed: true }), call(300n, { everLapsed: true })],
      vouchers: DEAD_VOUCHER,
    });
    await h.service.run(ASSET as never);
    expect(h.lapsedCalls).toEqual([]);
    expect(h.closedCalls[0]?.mark).toMatch(/^provider_forfeit:/);
  });

  it('mixed lane: only the renewed rows stay debt; never-debt rows keep the platform void', async () => {
    const h = build({
      lanes: [lane({ lastSkipReason: 'SEND_FAILED' })],
      calls: [call(200n, { everLapsed: true }), call(300n)],
      vouchers: DEAD_VOUCHER,
    });
    await h.service.run(ASSET as never);
    expect(h.lapsedCalls.map((l) => l.ids)).toEqual([['i200']]);
    expect(h.closedCalls.map((c) => c.ids)).toEqual([['i300']]);
  });
});

describe('B-L2: T_term compares one clock (the database’s)', () => {
  const service = (appMs: number, resolve = jest.fn(async () => undefined)) =>
    ({
      resolve,
      service: new ChannelSettlementService(
        {} as never,
        { resolve, findById: jest.fn(async () => null) } as never,
        {} as never,
        { emit: async () => undefined } as never,
        new Set([CHAIN]),
        DEFAULT_CHANNEL_POLICY,
        null,
        () => appMs,
      ) as unknown as { terminalTimeout(rows: unknown[]): Promise<boolean> },
    }) as const;
  const row = (ageSeconds: number) => ({
    organizationId: 'org',
    intentId: 'i-1',
    status: PaymentIntentStatus.PROVIDER_EXECUTING,
    createdAt: new Date(NOW * 1000),
    ageSeconds,
  });

  it('app clock 6 min ahead of the DB: a call the DB aged 5 s is NOT voided', async () => {
    const h = service(NOW * 1000 + 6 * 60 * 1000);
    expect(await h.service.terminalTimeout([row(5)])).toBe(false);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('app clock behind the DB: a call the DB aged past T_term IS closed', async () => {
    const h = service(NOW * 1000 - 10 * 60 * 1000);
    expect(await h.service.terminalTimeout([row(301)])).toBe(true);
    expect(h.resolve).toHaveBeenCalledWith(
      'org',
      'i-1',
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VOIDED,
      expect.anything(),
    );
  });
});

describe('B-S1: T_term stays above the provider-call deadline', () => {
  it('the default T_term (300 s) is above the default router deadline (30 s) + the margin', () => {
    expect(terminalTimeoutRefusal(300, {})).toBeNull();
    expect(DEFAULT_CHANNEL_POLICY.terminalTimeoutSeconds).toBeGreaterThan(
      30 + TERMINAL_TIMEOUT_MARGIN_SECONDS,
    );
  });

  it('a router deadline that would let a running call reach T_term refuses the boot', () => {
    expect(terminalTimeoutRefusal(300, { ROUTER_TOTAL_DEADLINE_MS: '180000' })).toMatch(
      /terminal timeout/,
    );
    expect(() => loadChannelPolicy({ ROUTER_TOTAL_DEADLINE_MS: '200000' })).toThrow(
      /Channel boot check/,
    );
    expect(terminalTimeoutRefusal(300, { ROUTER_TOTAL_DEADLINE_MS: '179000' })).toBeNull();
  });
});

describe('B-3: deadline items are taken round-robin across providers', () => {
  const plan = (provider: string, deadline: number, trigger = 'DEADLINE') => ({
    trigger,
    deadline,
    channel: { providerAccount: provider },
    name: `${provider}@${deadline}`,
  });

  it('one provider’s many deadline lanes cannot all go before another provider’s', () => {
    const order = fairDeadlineOrder([
      plan('A', 100),
      plan('A', 101),
      plan('A', 102),
      plan('A', 103),
      plan('B', 150),
      plan('C', 200),
      plan('X', 50, 'AGE'),
    ]);
    expect(order.map((p) => p.name)).toEqual([
      'A@100',
      'B@150',
      'C@200',
      'A@101',
      'A@102',
      'A@103',
      'X@50',
    ]);
  });
});

describe('M-1: refundId, the new skip reasons and the dropped verdict', () => {
  it('refundId = keccak256(toBytes(intentId)), deterministic per call', () => {
    const id = '5f0c3a3e-8a43-4a43-9b7c-0d4e3b2f1a10';
    expect(channelRefundId(id)).toBe(keccak256(toBytes(id)));
    expect(channelRefundId(id)).toBe(channelRefundId(id));
    expect(channelRefundId(id)).not.toBe(channelRefundId(`${id}x`));
  });

  it('the skip enums carry the contract’s new members at their indexes', () => {
    expect(REFUND_SKIP_REASONS[3]).toBe('AlreadyRefunded');
    expect(SETTLE_SKIP_REASONS[12]).toBe('BadSignature');
    // A malformed signature passed admission's own checks: not the buyer's to owe.
    expect(classifyLapse('BadSignature')).toBe('PLATFORM');
  });

  it('DropWatch: DROPPED must hold for 30 s with no IN_FLIGHT in between', () => {
    let now = 0;
    const watch = new DropWatch(() => now);
    expect(watch.confirm('s', 'DROPPED')).toBe(false); // first sighting
    now += (CHANNEL_DROP_CONFIRM_SECONDS - 1) * 1000;
    expect(watch.confirm('s', 'DROPPED')).toBe(false);
    now += 1000;
    expect(watch.confirm('s', 'DROPPED')).toBe(true);
    // An IN_FLIGHT answer starts over.
    expect(watch.confirm('t', 'DROPPED')).toBe(false);
    now += 20_000;
    expect(watch.confirm('t', 'IN_FLIGHT')).toBe(false);
    now += 20_000;
    expect(watch.confirm('t', 'DROPPED')).toBe(false);
  });

  it('droppedByNonce reads nonces and receipts in ONE batched read when the door has it', async () => {
    const sender = `0x${'90'.repeat(20)}`;
    const door = {
      confirmedNonce: jest.fn(),
      txReceipt: jest.fn(),
      nonceAndReceipts: jest.fn(async () => ({
        nonces: new Map([[sender, 8n]]),
        receipts: new Map([['0xabc', 'UNKNOWN' as const]]),
      })),
    };
    const channels = { attemptsOf: async () => new Map([['0xabc', { sender, nonce: 7n }]]) };
    expect(
      (await droppedByNonce(door as never, channels as never, ASSET as never, ['0xabc'])).verdict,
    ).toBe('DROPPED');
    expect(door.nonceAndReceipts).toHaveBeenCalledTimes(1);
    expect(door.confirmedNonce).not.toHaveBeenCalled();
    expect(door.txReceipt).not.toHaveBeenCalled();
    // A PENDING (known, not mined) or MINED answer in the same batch: in flight.
    door.nonceAndReceipts.mockResolvedValueOnce({
      nonces: new Map([[sender, 8n]]),
      receipts: new Map([['0xabc', 'PENDING' as never]]),
    });
    expect(
      (await droppedByNonce(door as never, channels as never, ASSET as never, ['0xabc'])).verdict,
    ).toBe('IN_FLIGHT');
    // The batch failing is never "dropped".
    door.nonceAndReceipts.mockRejectedValueOnce(new Error('batch refused'));
    expect(
      (await droppedByNonce(door as never, channels as never, ASSET as never, ['0xabc'])).verdict,
    ).toBe('IN_FLIGHT');
  });
});
