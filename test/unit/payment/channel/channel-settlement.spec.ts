import { getAddress } from 'viem';

import { VoucherChannelStatus } from '@database/postgres/entities/voucher-channel.entity';
import { AlertSeverity } from '@shared/alerting';
import { DEFAULT_CHANNEL_POLICY } from '@modules/payment/domain/channel/channel-policy';
import { EMPTY_SLOT } from '@modules/payment/domain/channel/channel-voucher';
import { ChannelSettlementService } from '@modules/payment/services/channel-settlement.service';

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

function build(options: {
  lanes?: any[];
  calls?: any[];
  slot?: any;
  frozen?: boolean;
  simulateSkip?: string;
  vouchers?: any[];
  window?: Record<string, unknown>;
  risk?: Record<string, boolean>;
}) {
  const sent: { kind: string; lane?: string; items?: number }[] = [];
  const alerts: { severity: string; name: string }[] = [];
  const statuses: { id: string; status: string; reason: string }[] = [];
  const released: { id: string; status: string; reason: string }[] = [];
  const booked: string[] = [];
  const bound: any[] = [];
  const marked: { id: string; txRef: string | null }[] = [];
  const unpaid: any[] = [];
  const skips: { id: string; reason: string | null }[] = [];
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
    bindSettlement: async (input: any) => {
      bound.push(input);
      return 'settlement-1';
    },
    markSent: async (id: string, txRef: string | null) => void marked.push({ id, txRef }),
    releaseSettlement: async (id: string, status: string, reason: string) =>
      void released.push({ id, status, reason }),
    findSettlement: async () => {
      const last = bound[bound.length - 1];
      return {
        id: 'settlement-1',
        fromSettled: last ? String(last.fromSettled) : '100',
        toCumulative: last ? String(last.toCumulative) : '300',
        toCalls: last?.toCalls ?? 3,
        charge: last ? String(last.charge) : '200',
        chargedIntentIds: last?.chargedIntentIds ?? [],
        txRefs: [],
      };
    },
    findReleasedTo: async () => null,
    releasedTo: async () => [],
    findInFlightTxs: async () => [],
    findUnbookedCollects: async () => [],
    markTxBooked: async () => undefined,
    collectedByTx: async () => 0n,
    insertTx: async () => 'tx-1',
    appendTxRef: async () => undefined,
    finishTx: async () => undefined,
    recordUnpaid: async (row: any) => void unpaid.push(row),
    setLastSkip: async (id: string, reason: string | null) => void skips.push({ id, reason }),
    closeUnsettled: async () => [],
    claimRequests: async () => [],
    markClaimed: async () => undefined,
    landSettlement: async () => true,
    bookCharged: async (_m: unknown, _c: string, ids: string[]) => {
      booked.push(...ids);
      return ids.length;
    },
    markWaived: async () => undefined,
    deferBucket: async () => undefined,
    refreshOldestUnsettled: async () => undefined,
    setStatus: async (id: string, status: string, reason: string) =>
      void statuses.push({ id, status, reason }),
    recordCollected: async () => undefined,
    markPaidOut: async () => undefined,
    lapse: async () => 0,
    closeIdle: async () => 0,
  };
  const intents = {
    resolve: jest.fn(async () => undefined),
    bookHeldCollected: jest.fn(async () => undefined),
    findById: jest.fn(async () => ({ price: { amount: '100', asset: ASSET, decimals: 6 } })),
    releaseHold: jest.fn(),
    bookBlockedProviderRefund: jest.fn(async () => ({ booked: true, disputeIds: [] })),
  };
  const door = {
    doorLive: async () => true,
    txReceipt: async () => ({ state: 'UNKNOWN' }),
    signerWindow: async () => ({
      validUntil: null,
      revoked: false,
      revokeGraceEndsAt: null,
      heldCapsEndAt: null,
      ...options.window,
    }),
    providerRisk: async () => ({
      unbonding: false,
      slashPending: false,
      nearFloor: false,
      blocked: false,
      ...options.risk,
    }),
    chainNow: async () => NOW,
    collectHoldSeconds: async () => 3_600,
    takeRateBps: async () => 1_000,
    treasury: async () => getAddress(`0x${'ee'.repeat(20)}`),
    isFrozen: async (_a: unknown, address: string) =>
      options.frozen === true && address === PROVIDER,
    readBooks: async () => ({
      slot: options.slot ?? { ...EMPTY_SLOT, settled: 100n },
      unpaid: 0n,
      totalUnpaid: 0n,
      held: 0n,
    }),
    simulateSettle: async (_a: unknown, items: any[]) =>
      items.map((item, index) =>
        options.simulateSkip
          ? {
              kind: 'SKIPPED',
              index,
              key: null,
              cumulative: item.voucher.cumulative,
              reason: options.simulateSkip,
            }
          : {
              kind: 'SETTLED',
              index,
              key: '0x',
              cumulative: item.voucher.cumulative,
              calls: item.voucher.calls,
              charge: item.charge,
              maturityHour: 0,
              takeRateBps: 0,
              opened: null,
              deferred: null,
            },
      ),
    settle: async (_a: unknown, items: any[], laneName: string) => {
      sent.push({ kind: 'settle', lane: laneName, items: items.length });
      return {
        txRef: '0xsettle',
        landedAt: NOW,
        outcomes: items.map((item, index) => ({
          kind: 'SETTLED',
          index,
          key: `0x${'0c'.repeat(32)}`,
          cumulative: item.voucher.cumulative,
          calls: item.voucher.calls,
          charge: item.charge,
          maturityHour: HOUR + 1,
          takeRateBps: 1_000,
          opened: null,
          deferred: null,
        })),
      };
    },
    collect: async (_a: unknown, refs: any[], keep: bigint[]) => {
      sent.push({ kind: 'collect', items: refs.length });
      return {
        txRef: '0xcollect',
        landedAt: NOW,
        paid: [
          {
            key: `0x${'0c'.repeat(32)}`,
            provider: PROVIDER,
            maturityHour: HOUR - 1,
            gross: 200n - keep[0],
            fee: 20n,
          },
        ],
        skipped: [],
        deferred: options.frozen ? [{ to: PROVIDER, amount: 180n }] : [],
      };
    },
  };
  const service = new ChannelSettlementService(
    channels as never,
    intents as never,
    door as never,
    { emit: async (alert: any) => void alerts.push(alert) } as never,
    new Set([CHAIN]),
    DEFAULT_CHANNEL_POLICY,
    null,
    () => NOW * 1000,
  );
  return {
    service,
    sent,
    alerts,
    statuses,
    released,
    booked,
    intents,
    bound,
    marked,
    unpaid,
    skips,
  };
}

describe('ChannelSettlementService (v3 §5.4, SPEC-W2 §3)', () => {
  it('the flag gates admission only: an existing channel on a chain that is not live still settles (L7)', async () => {
    const h = build({
      calls: [
        call(200n, { createdAt: new Date((NOW - 1_800) * 1000) }),
        call(300n, { createdAt: new Date((NOW - 1_800) * 1000) }),
      ],
    });
    (h.service as any).liveChains = new Set();
    await h.service.run(ASSET as never);
    expect(h.sent).toEqual([{ kind: 'settle', lane: 'ORDINARY', items: 1 }]);
  });

  it('collects an ACTIVE channel’s matured bucket first, whatever the cadence, FIFO, keeping disputed calls', async () => {
    const matured = new Date((NOW - 3_600) * 1000);
    const h = build({
      slot: { ...EMPTY_SLOT, settled: 100n, h1: 200n, m1: HOUR - 1, r1: 1_000 },
      calls: [
        call(40n, {
          heldStatus: 'HELD',
          collectableAt: matured,
          intentId: 'kept',
          disputeOutcome: 'OPEN',
        }),
        call(50n, { heldStatus: 'HELD', collectableAt: matured, intentId: 'paid' }),
        call(200n),
      ],
    });
    await h.service.run(ASSET as never);
    expect(h.sent[0]).toEqual({ kind: 'collect', items: 1 });
    expect(h.intents.bookHeldCollected).toHaveBeenCalledWith('org', 'paid', '0xcollect');
    expect(h.intents.bookHeldCollected).not.toHaveBeenCalledWith('org', 'kept', expect.anything());
  });

  it('collects a FROZEN provider anyway (payout to unpaid) and pages it', async () => {
    const matured = new Date((NOW - 3_600) * 1000);
    const h = build({
      frozen: true,
      slot: { ...EMPTY_SLOT, settled: 100n, h1: 200n, m1: HOUR - 1, r1: 1_000 },
      calls: [
        call(50n, { heldStatus: 'HELD', collectableAt: matured }),
        call(60n, { heldStatus: 'HELD', collectableAt: matured }),
        call(200n),
      ],
    });
    await h.service.run(ASSET as never);
    expect(h.sent[0].kind).toBe('collect');
    const names = h.alerts.map((a) => a.name);
    expect(names).toContain('channel_payout_recipient_frozen');
    expect(names).toContain('channel_transfer_deferred');
    expect(h.alerts.find((a) => a.name === 'channel_payout_recipient_frozen')!.severity).toBe(
      AlertSeverity.CRITICAL,
    );
  });

  it('a young channel does not settle; at T_age it does, on the ordinary lane, and its calls go into hold', async () => {
    const young = build({ calls: [call(200n), call(300n)] });
    await young.service.run(ASSET as never);
    expect(young.sent).toEqual([]);

    const aged = build({
      calls: [
        call(200n, { createdAt: new Date((NOW - 1_800) * 1000) }),
        call(300n, { createdAt: new Date((NOW - 1_800) * 1000) }),
      ],
    });
    await aged.service.run(ASSET as never);
    expect(aged.sent).toEqual([{ kind: 'settle', lane: 'ORDINARY', items: 1 }]);
  });

  it('the deadline trigger settles on the DEADLINE budget lane', async () => {
    const h = build({
      calls: [call(200n), call(300n)],
      vouchers: [
        // expiresAt + 7200 − 3600 ≤ chainNow: at the deadline trigger.
        {
          id: 'v3',
          cumulative: '300',
          calls: 3,
          issuedAt: String(NOW - 3_900),
          expiresAt: String(NOW - 3_700),
          signature: `0x${'11'.repeat(65)}`,
        },
      ],
    });
    await h.service.run(ASSET as never);
    expect(h.sent).toEqual([{ kind: 'settle', lane: 'DEADLINE', items: 1 }]);
  });

  it('drops an item the simulation skips, before the send, and pages the reason', async () => {
    const h = build({
      simulateSkip: 'Balance',
      calls: [call(200n, { createdAt: new Date((NOW - 1_800) * 1000) }), call(300n)],
    });
    await h.service.run(ASSET as never);
    expect(h.sent).toEqual([]);
    expect(h.released[0]).toMatchObject({ status: 'DROPPED', reason: 'sim:Balance' });
    expect(h.alerts.map((a) => a.name)).toContain('channel_settle_skipped');
  });

  it('a channel with no free bucket is ROTATED, not sent', async () => {
    const h = build({
      // Both buckets pending at OTHER rates: the contract would skip NoBucket.
      slot: {
        ...EMPTY_SLOT,
        settled: 100n,
        h1: 5n,
        m1: HOUR + 2,
        r1: 900,
        h2: 5n,
        m2: HOUR + 3,
        r2: 800,
      },
      calls: [call(200n, { createdAt: new Date((NOW - 1_800) * 1000) }), call(300n)],
    });
    await h.service.run(ASSET as never);
    expect(h.sent.filter((s) => s.kind === 'settle')).toEqual([]);
    expect(h.statuses).toContainEqual({
      id: 'lane-1',
      status: VoucherChannelStatus.ROTATED,
      reason: 'NO_BUCKET',
    });
  });

  it('a pre-settlement dispute is charged into hold and kept (SPEC-W2 §5): the lane rotates', async () => {
    const h = build({
      calls: [
        call(200n, {
          createdAt: new Date((NOW - 1_800) * 1000),
          disputeOutcome: 'OPEN',
          settlementId: 'settlement-1',
        }),
        call(300n, { settlementId: 'settlement-1' }),
      ],
    });
    await h.service.run(ASSET as never);
    expect(h.booked).toEqual(['i200', 'i300']);
    expect(h.statuses).toContainEqual({
      id: 'lane-1',
      status: VoucherChannelStatus.ROTATED,
      reason: 'DISPUTE_KEPT',
    });
  });

  it('an urgent request (debt replacement, 80% reservation) skips the age wait, once per payer per interval', async () => {
    const urgentLane = lane({ urgentRequestedAt: new Date(NOW * 1000) });
    const h = build({ lanes: [urgentLane], calls: [call(200n), call(300n)] });
    await h.service.run(ASSET as never);
    expect(h.sent).toEqual([{ kind: 'settle', lane: 'URGENT', items: 1 }]);
    h.sent.length = 0;
    await h.service.run(ASSET as never);
    expect(h.sent).toEqual([]);
  });

  it('drains every channel on a take-rate change', async () => {
    const h = build({ calls: [call(200n), call(300n)] });
    await h.service.run(ASSET as never);
    expect(h.sent).toEqual([]);
    (h.service as any).door.takeRateBps = async () => 1_200;
    await h.service.run(ASSET as never);
    expect(h.sent.map((s) => s.kind)).toEqual(['settle']);
  });

  describe('the inputs of D and the provider-risk trigger (v3 §5.4.3)', () => {
    it('a revoked delegate settles before its grace ends, on the deadline lane', async () => {
      const h = build({
        calls: [call(200n), call(300n)],
        window: { revoked: true, revokeGraceEndsAt: NOW + 3_000 },
      });
      await h.service.run(ASSET as never);
      expect(h.sent).toEqual([{ kind: 'settle', lane: 'DEADLINE', items: 1 }]);
    });

    it('a caps hold that ends soon is a deadline too', async () => {
      const h = build({ calls: [call(200n), call(300n)], window: { heldCapsEndAt: NOW + 3_500 } });
      await h.service.run(ASSET as never);
      expect(h.sent).toEqual([{ kind: 'settle', lane: 'DEADLINE', items: 1 }]);
    });

    it('a far grace or hold end changes nothing for a young channel', async () => {
      const h = build({ calls: [call(200n), call(300n)], window: { heldCapsEndAt: NOW + 50_000 } });
      await h.service.run(ASSET as never);
      expect(h.sent).toEqual([]);
    });

    it.each(['unbonding', 'slashPending', 'nearFloor', 'blocked'])(
      'provider risk (%s) settles a young channel now',
      async (signal) => {
        const h = build({ calls: [call(200n), call(300n)], risk: { [signal]: true } });
        await h.service.run(ASSET as never);
        expect(h.sent.map((x) => x.kind)).toEqual(['settle']);
      },
    );

    it('an operator drain is never rate-limited', async () => {
      const drained = lane({ urgentRequestedAt: new Date(NOW * 1000), urgentReason: 'DRAIN' });
      const h = build({ lanes: [drained], calls: [call(200n), call(300n)] });
      await h.service.run(ASSET as never);
      await h.service.run(ASSET as never);
      expect(h.sent).toEqual([
        { kind: 'settle', lane: 'URGENT', items: 1 },
        { kind: 'settle', lane: 'URGENT', items: 1 },
      ]);
    });
  });

  describe('terminal timeout (v3 §5.4.1)', () => {
    const old = new Date((NOW - 301) * 1000);
    it.each([
      ['CREATED', 'EXPIRED'],
      ['FUNDS_SECURED', 'EXPIRED'],
      ['PROVIDER_EXECUTING', 'VOIDED'],
    ])(
      'a %s channel call older than T_term is closed as %s by the scheduler',
      async (status, target) => {
        const h = build({ calls: [call(200n, { status, createdAt: old })] });
        await h.service.run(ASSET as never);
        expect(h.intents.resolve).toHaveBeenCalledWith('org', 'i200', status, target, {
          reason: 'channel_terminal_timeout',
        });
      },
    );

    it('a SERVED (VERIFYING) call at T_term is settled as served and unverified, not voided (M2)', async () => {
      const h = build({ calls: [call(200n, { status: 'VERIFYING', createdAt: old })] });
      await h.service.run(ASSET as never);
      expect(h.intents.resolve).toHaveBeenCalledWith('org', 'i200', 'VERIFYING', 'SETTLED', {
        reason: 'channel_terminal_timeout_unverified',
        settledAmount: { amount: '100', asset: ASSET, decimals: 6 },
      });
    });

    it('leaves a young call, and a terminal one, alone', async () => {
      const h = build({
        calls: [
          call(200n, { status: 'VERIFYING', createdAt: new Date((NOW - 299) * 1000) }),
          call(300n, { status: 'SETTLED', createdAt: old }),
        ],
      });
      await h.service.run(ASSET as never);
      expect(h.intents.resolve).not.toHaveBeenCalled();
    });

    it('a verdict that wins the race is not an error', async () => {
      const h = build({ calls: [call(200n, { status: 'VERIFYING', createdAt: old })] });
      h.intents.resolve.mockRejectedValue(new Error('PAYMENT_INVALID_STATE_TRANSITION') as never);
      await expect(h.service.run(ASSET as never)).resolves.toBeUndefined();
    });
  });
});
