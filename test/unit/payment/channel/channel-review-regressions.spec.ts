import { getAddress } from 'viem';

import { VoucherChannelStatus } from '@database/postgres/entities/voucher-channel.entity';
import { BlockedRole } from '@modules/blocklist/domain/account-block';
import { AlertSeverity } from '@shared/alerting';
import {
  classifyLapse,
  DEFAULT_CHANNEL_POLICY,
  channelBootRefusal,
  decideRound,
  laneOfTrigger,
  nextPayoutAtByDoor,
} from '@modules/payment/domain/channel/channel-policy';
import { EMPTY_SLOT, channelRefundId } from '@modules/payment/domain/channel/channel-voucher';
import { maxOpenChannelsOn } from '@modules/payment/constants/channel.constants';
import {
  ChannelNotSentError,
  ChannelSendDeferredError,
  channelSendNotSent,
} from '@modules/payment/ports/channel-door.port';
import { ChannelRefundService } from '@modules/payment/services/channel-refund.service';
import { ChannelSettlementService } from '@modules/payment/services/channel-settlement.service';

/**
 * Regression tests for the 2026-10-31 W2 security and business reviews. The
 * first block is the security review's adversarial repro suite
 * (`review-adversarial.spec.ts`, R1–R4), each turned around: it reproduced the
 * bug, it now proves the fix.
 */

const CHAIN = 'eip155:46630';
const ASSET = `${CHAIN}/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac`;
const PAYER = getAddress(`0x${'aa'.repeat(20)}`);
const PROVIDER = getAddress(`0x${'bb'.repeat(20)}`);
const KEY = `0x${'0c'.repeat(32)}`;
const NOW = 1_800_000_000; // on the hour grid
const HOUR = NOW / 3_600;
const AGED = new Date((NOW - 1_800) * 1000);

function lane(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lane-1',
    chainId: CHAIN,
    assetId: ASSET,
    payer: `${CHAIN}:${PAYER}`,
    signer: `${CHAIN}:${PAYER}`,
    providerAccount: `${CHAIN}:${PROVIDER}`,
    providerId: 'provider-1',
    organizationId: 'org',
    channelId: `0x${'5a'.repeat(32)}`,
    channelKey: KEY,
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
    lastSkipReason: null,
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
    holdId: `h${cumulative}`,
    closed: false,
    ...overrides,
  };
}

const VOUCHER = {
  id: 'v3',
  cumulative: '300',
  calls: 3,
  issuedAt: String(NOW - 30),
  expiresAt: String(NOW + 200),
  signature: `0x${'11'.repeat(65)}`,
};

function settledOutcome(item: any, index: number) {
  return {
    kind: 'SETTLED',
    index,
    key: KEY,
    cumulative: item.voucher.cumulative,
    calls: item.voucher.calls,
    charge: item.charge,
    maturityHour: HOUR + 1,
    takeRateBps: 1_000,
    opened: null,
    deferred: null,
  };
}

function build(options: {
  lanes?: any[];
  calls?: any[] | (() => any[]);
  slot?: any;
  vouchers?: any[];
  risk?: Record<string, boolean>;
  inFlight?: any[];
  blocked?: (parties: any[]) => any;
  onBind?: (input: any) => void;
  /** Recorded (sender, nonce) per hash, and the sender's confirmed nonce. */
  attempts?: Record<string, { sender: string; nonce: bigint }>;
  confirmedNonce?: bigint;
  /** Released settlements to a target (`releasedTo`), newest first. */
  releasedTo?: any[];
  /** LANDED collects not booked yet, and what each already booked per channel. */
  unbooked?: any[];
  collectedByTx?: bigint;
}) {
  const sent: { kind: string; lane?: string; items?: number }[] = [];
  const alerts: { severity: string; name: string; summary: string; details: any }[] = [];
  const statuses: { id: string; status: string; reason: string }[] = [];
  const released: { id: string; status: string; reason: string }[] = [];
  const booked: string[] = [];
  const bound: any[] = [];
  const marked: { id: string; txRef: string | null }[] = [];
  const skips: { id: string; reason: string | null }[] = [];
  const closed: { ids: string[]; mark: string }[] = [];
  const lapsed: { ids: string[]; cause: string }[] = [];
  const attemptsRecorded: { hash: string; sender: string; nonce: bigint }[] = [];
  const txBooked: string[] = [];
  const lanes = options.lanes ?? [lane()];
  const rowsOf = () =>
    typeof options.calls === 'function' ? options.calls() : (options.calls ?? []);
  const channels = {
    manager: { transaction: async (fn: any) => fn({}) },
    findInFlight: async () => options.inFlight ?? [],
    findById: async (id: string) => lanes.find((l) => l.id === id) ?? null,
    listActive: async () => lanes,
    activeAssets: async () => [ASSET],
    assetsWithClaimRequests: async () => [],
    calls: async () => rowsOf(),
    vouchers: async () => options.vouchers ?? [VOUCHER],
    cadenceOf: async () => new Map(),
    setDeadline: async () => undefined,
    clearUrgent: async () => undefined,
    bindSettlement: async (input: any) => {
      bound.push(input);
      options.onBind?.(input);
      return 'settlement-1';
    },
    markSent: async (id: string, txRef: string | null) => void marked.push({ id, txRef }),
    releaseSettlement: async (id: string, status: string, reason: string) =>
      void released.push({ id, status, reason }),
    findSettlement: async () => {
      const last = bound[bound.length - 1];
      const flight = options.inFlight?.[0];
      return last
        ? {
            id: 'settlement-1',
            fromSettled: String(last.fromSettled),
            toCumulative: String(last.toCumulative),
            toCalls: last.toCalls,
            charge: String(last.charge),
            chargedIntentIds: last.chargedIntentIds ?? [],
            txRefs: [],
          }
        : flight;
    },
    findReleasedTo: async () => null,
    releasedTo: async () => options.releasedTo ?? [],
    // As the database does: the channel's settled value moves to the landing.
    landSettlement: async (_m: unknown, _s: string, id: string, landed: any) => {
      const row = lanes.find((l) => l.id === id);
      if (row) row.settledCumulative = landed.cumulative.toString();
      return true;
    },
    bookCharged: async (_m: unknown, _c: string, ids: string[]) => {
      booked.push(...ids);
      return ids.length;
    },
    markWaived: async () => undefined,
    deferBucket: async () => undefined,
    refreshOldestUnsettled: async () => undefined,
    setStatus: async (id: string, status: string, reason: string) =>
      void statuses.push({ id, status, reason }),
    setLastSkip: async (id: string, reason: string | null) => void skips.push({ id, reason }),
    recordCollected: async () => undefined,
    markPaidOut: async () => undefined,
    lapse: async (_c: string, ids: string[], cause: string) => {
      lapsed.push({ ids: [...ids], cause });
      return ids.length;
    },
    closeUnsettled: async (_c: string, ids: string[], mark: string) => {
      closed.push({ ids: [...ids], mark });
      return ids.map((intentId) => ({ organizationId: 'org', intentId, holdId: `h-${intentId}` }));
    },
    closeIdle: async () => 0,
    refreshSettlementTotals: async () => 0,
    recordAttempt: async (hash: string, sender: string, nonce: bigint) =>
      void attemptsRecorded.push({ hash, sender, nonce }),
    attemptsOf: async (hashes: string[]) =>
      new Map(
        hashes
          .filter((hash) => options.attempts?.[hash])
          .map((hash) => [hash, options.attempts![hash]] as const),
      ),
    findInFlightTxs: async () => [],
    findUnbookedCollects: async () => options.unbooked ?? [],
    markTxBooked: async (id: string) => void txBooked.push(id),
    collectedByTx: async () => options.collectedByTx ?? 0n,
    insertTx: async () => 'tx-1',
    appendTxRef: async () => undefined,
    finishTx: async () => undefined,
    discardUnsentTx: async () => true,
    recordUnpaid: async () => undefined,
    claimRequests: async () => [],
    markClaimed: async () => undefined,
  };
  const intents = {
    resolve: jest.fn(async () => undefined),
    bookHeldCollected: jest.fn(async () => undefined),
    findById: jest.fn(async () => ({
      holdId: 'h',
      price: { amount: '100', asset: ASSET, decimals: 6 },
    })),
    releaseHold: jest.fn(async () => true),
    bookBlockedProviderRefund: jest.fn(async () => ({ booked: true, disputeIds: [] })),
  };
  const door: any = {
    doorLive: async () => true,
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
      ...options.risk,
    }),
    chainNow: async () => NOW,
    collectHoldSeconds: async () => 3_600,
    takeRateBps: async () => 1_000,
    treasury: async () => getAddress(`0x${'ee'.repeat(20)}`),
    isFrozen: async () => false,
    readBooks: async () => ({
      slot: options.slot ?? { ...EMPTY_SLOT, settled: 100n },
      unpaid: 0n,
      totalUnpaid: 0n,
      held: 0n,
    }),
    txReceipt: jest.fn(async () => ({ state: 'UNKNOWN' })),
    confirmedNonce: jest.fn(async () => options.confirmedNonce ?? 0n),
    simulateSettle: async (_a: unknown, items: any[]) =>
      items.map((item, index) => ({ ...settledOutcome(item, index), key: '0x', maturityHour: 0 })),
    settle: async (_a: unknown, items: any[], laneName: string, opts?: any) => {
      sent.push({ kind: 'settle', lane: laneName, items: items.length });
      await opts?.beforeBroadcast?.('0xabc', { from: `0x${'90'.repeat(20)}`, nonce: 7n });
      return { txRef: '0xabc', landedAt: NOW, outcomes: items.map(settledOutcome) };
    },
    collect: async (_a: unknown, refs: any[], keep: bigint[]) => {
      sent.push({ kind: 'collect', items: refs.length });
      return {
        txRef: '0xcollect',
        landedAt: NOW,
        paid: [
          { key: KEY, provider: PROVIDER, maturityHour: HOUR - 1, gross: 200n - keep[0], fee: 20n },
        ],
        skipped: [],
        deferred: [],
      };
    },
  };
  const refunds = { refund: jest.fn(async () => ({ kind: 'REFUNDED', txRef: '0xrefund' })) };
  const blocklist = options.blocked
    ? { firstBlocked: jest.fn((parties: any[]) => options.blocked!(parties)) }
    : null;
  let clock = NOW * 1000;
  const service = new ChannelSettlementService(
    channels as never,
    intents as never,
    door as never,
    { emit: async (alert: any) => void alerts.push(alert) } as never,
    new Set([CHAIN]),
    DEFAULT_CHANNEL_POLICY,
    null,
    () => clock,
    refunds as never,
    blocklist as never,
  );
  return {
    /** Moves the wall clock (the drop verdict's time gap, M-1). */
    advance: (seconds: number) => void (clock += seconds * 1000),
    service,
    door,
    sent,
    alerts,
    statuses,
    released,
    booked,
    bound,
    marked,
    skips,
    closed,
    lapsed,
    intents,
    refunds,
    attemptsRecorded,
    txBooked,
  };
}

describe('W2 review regressions (security review R1–R4, ported and inverted)', () => {
  it('R1 (H2): a settle that throws AFTER broadcast (receipt timeout) stays SENT, never released', async () => {
    const h = build({ calls: [call(200n, { createdAt: AGED }), call(300n, { createdAt: AGED })] });
    h.door.settle = async (_a: unknown, _items: any[], _lane: string, opts: any) => {
      await opts.beforeBroadcast('0xabc');
      throw new Error('Timed out while waiting for transaction with hash 0xabc to be confirmed.');
    };
    await h.service.run(ASSET as never);
    expect(h.released).toEqual([]);
    // The hash was recorded on the settlement before the broadcast.
    expect(h.marked).toContainEqual({ id: 'settlement-1', txRef: '0xabc' });
    expect(h.alerts.map((a) => a.name)).toContain('channel_settle_outcome_unknown');
  });

  it('R1: the next pass reads the SENT settlement back by its hash and books it', async () => {
    const inFlight = {
      id: 'settlement-1',
      channelRowId: 'lane-1',
      fromSettled: '100',
      toCumulative: '300',
      toCalls: 3,
      charge: '200',
      chargedIntentIds: ['i200', 'i300'],
      txRefs: ['0xabc'],
      status: 'SENT',
      createdAt: new Date((NOW - 600) * 1000),
    };
    const h = build({
      inFlight: [inFlight],
      slot: { ...EMPTY_SLOT, settled: 300n, h1: 200n, m1: HOUR + 1, r1: 1_000 },
      calls: [
        call(200n, { createdAt: AGED, settlementId: 'settlement-1' }),
        call(300n, { createdAt: AGED, settlementId: 'settlement-1' }),
      ],
    });
    h.door.txReceipt = jest.fn(async () => ({
      state: 'MINED',
      success: true,
      txRef: '0xabc',
      landedAt: NOW - 500,
      settled: [settledOutcome({ voucher: { cumulative: 300n, calls: 3 }, charge: 200n }, 0)],
      collected: [],
      collectSkipped: [],
      deferred: [],
      refunded: [],
      refundSkipped: [],
    }));
    await h.service.run(ASSET as never);
    expect(h.booked).toEqual(['i200', 'i300']);
    expect(h.released).toEqual([]);
  });

  const unknownInFlight = (ageSeconds: number) => ({
    id: 'settlement-1',
    channelRowId: 'lane-1',
    fromSettled: '100',
    toCumulative: '300',
    txRefs: ['0xabc'],
    createdAt: new Date((NOW - ageSeconds) * 1000),
  });
  const ATTEMPT = { '0xabc': { sender: `0x${'90'.repeat(20)}`, nonce: 7n } };

  it('R1 (nonce rule): an unknown hash is NOT released on a timer while its nonce is unused — paged as stuck', async () => {
    const h = build({
      inFlight: [unknownInFlight(3_600)],
      calls: [],
      attempts: ATTEMPT,
      confirmedNonce: 7n, // nonce 7 not used yet
    });
    await h.service.run(ASSET as never);
    expect(h.released).toEqual([]);
    expect(h.alerts.map((a) => a.name)).toContain('channel_tx_stuck');
  });

  it('R1 (nonce rule): a hash with no recorded nonce is kept in flight', async () => {
    const h = build({ inFlight: [unknownInFlight(3_600)], calls: [], confirmedNonce: 100n });
    await h.service.run(ASSET as never);
    expect(h.released).toEqual([]);
  });

  it('R1 (nonce rule): released only once the confirmed nonce passed it with no receipt, and reported', async () => {
    const h = build({
      inFlight: [unknownInFlight(300)],
      calls: [],
      attempts: ATTEMPT,
      confirmedNonce: 8n,
    });
    // The first DROPPED verdict is only noted (sec-audit M-1 / B-S2) …
    await h.service.run(ASSET as never);
    expect(h.released).toEqual([]);
    // … still DROPPED under 30 s later: still not released …
    h.advance(29);
    await h.service.run(ASSET as never);
    expect(h.released).toEqual([]);
    // … held for 30 s: released.
    h.advance(1);
    await h.service.run(ASSET as never);
    expect(h.released).toEqual([
      { id: 'settlement-1', status: 'DROPPED', reason: 'nonce taken, no receipt' },
    ]);
    expect(h.alerts.map((a) => a.name)).toContain('channel_tx_nonce_taken');
  });

  it('records the sender and nonce with the hash before the broadcast', async () => {
    const h = build({ calls: [call(200n, { createdAt: AGED }), call(300n, { createdAt: AGED })] });
    await h.service.run(ASSET as never);
    expect(h.attemptsRecorded).toEqual([
      { hash: '0xabc', sender: `0x${'90'.repeat(20)}`, nonce: 7n },
    ]);
  });

  it('R1: a definite not-sent error releases the settlement for a retry', async () => {
    const h = build({ calls: [call(200n, { createdAt: AGED }), call(300n, { createdAt: AGED })] });
    h.door.settle = async () => {
      throw new ChannelNotSentError('the node refused it');
    };
    await h.service.run(ASSET as never);
    expect(h.released).toEqual([
      expect.objectContaining({ status: 'DROPPED', reason: 'send failed' }),
    ]);
    expect(h.skips).toContainEqual({ id: 'lane-1', reason: 'SEND_FAILED' });
  });

  it('R1b (H2): once the chain is ahead of the DB with nothing in flight, it is booked from the stored voucher', async () => {
    const h = build({
      slot: { ...EMPTY_SLOT, settled: 300n, h1: 200n, m1: HOUR + 1, r1: 1_000 },
      calls: [
        call(200n, { createdAt: new Date((NOW - 3_400) * 1000), settlementId: 'settlement-1' }),
        call(300n, { createdAt: new Date((NOW - 3_400) * 1000), settlementId: 'settlement-1' }),
      ],
    });
    await h.service.run(ASSET as never);
    // Nothing new sent for it: the chain already settled it.
    expect(h.sent.filter((s) => s.kind === 'settle')).toEqual([]);
    expect(h.bound[0]).toMatchObject({ toCumulative: 300n, trigger: 'RECOVER' });
    expect(h.booked).toEqual(['i200', 'i300']);
    expect(h.alerts.map((a) => a.name)).toContain('channel_landing_recovered');
  });

  const minedSettle = (txRef: string, charge: bigint) => ({
    state: 'MINED',
    success: true,
    txRef,
    landedAt: NOW - 500,
    settled: [settledOutcome({ voucher: { cumulative: 300n, calls: 3 }, charge }, 0)],
    collected: [],
    collectSkipped: [],
    deferred: [],
    refunded: [],
    refundSkipped: [],
  });

  it('L1: a send that landed between the books read and the receipt read is booked from the receipt, not released', async () => {
    const h = build({
      inFlight: [
        { ...unknownInFlight(600), toCalls: 3, charge: '200', chargedIntentIds: ['i200', 'i300'] },
      ],
      // The books (read first) still show the start…
      slot: { ...EMPTY_SLOT, settled: 100n },
      calls: [
        call(200n, { createdAt: AGED, settlementId: 'settlement-1' }),
        call(300n, { createdAt: AGED, settlementId: 'settlement-1' }),
      ],
    });
    // …and the receipt (read after) shows the settle.
    h.door.txReceipt = jest.fn(async () => minedSettle('0xabc', 200n));
    await h.service.run(ASSET as never);
    expect(h.released).toEqual([]);
    expect(h.booked).toEqual(['i200', 'i300']);
  });

  // `settlementId`: the harness's rows read back as bound once the bind ran.
  const aheadCalls = () => [
    call(200n, { createdAt: new Date((NOW - 3_400) * 1000), settlementId: 'settlement-1' }),
    call(300n, { createdAt: new Date((NOW - 3_400) * 1000), settlementId: 'settlement-1' }),
  ];
  const AHEAD_SLOT = { ...EMPTY_SLOT, settled: 300n, h1: 200n, m1: HOUR + 1, r1: 1_000 };

  it('L2: chain ahead — the released settlement whose receipt shows the settle is booked, not merely the newest', async () => {
    const h = build({
      slot: AHEAD_SLOT,
      calls: aheadCalls(),
      releasedTo: [
        { id: 'newer', chargedIntentIds: ['i200'], txRefs: ['0xnewer'] },
        { id: 'older', chargedIntentIds: ['i200', 'i300'], txRefs: ['0xolder'] },
      ],
    });
    h.door.txReceipt = jest.fn(async (_a: unknown, ref: string) =>
      ref === '0xolder' ? minedSettle('0xolder', 200n) : { state: 'UNKNOWN' },
    );
    await h.service.run(ASSET as never);
    expect(h.bound[0]).toMatchObject({ trigger: 'RECOVER', chargedIntentIds: ['i200', 'i300'] });
    expect(h.booked).toEqual(['i200', 'i300']);
  });

  it('L2: several released candidates and no receipt — not booked, CRITICAL', async () => {
    const h = build({
      slot: AHEAD_SLOT,
      calls: aheadCalls(),
      releasedTo: [
        { id: 'a', chargedIntentIds: ['i200'], txRefs: ['0xa'] },
        { id: 'b', chargedIntentIds: ['i200', 'i300'], txRefs: ['0xb'] },
      ],
    });
    await h.service.run(ASSET as never);
    expect(h.bound.filter((b) => b.trigger === 'RECOVER')).toEqual([]);
    expect(h.alerts.map((a) => a.name)).toContain('channel_chain_ahead_unknown');
  });

  it('L2: a receipt charge that differs from the bound calls is not booked, CRITICAL', async () => {
    const h = build({
      slot: AHEAD_SLOT,
      calls: aheadCalls(),
      releasedTo: [{ id: 'a', chargedIntentIds: ['i200', 'i300'], txRefs: ['0xa'] }],
    });
    h.door.txReceipt = jest.fn(async () => minedSettle('0xa', 100n));
    await h.service.run(ASSET as never);
    expect(h.bound.filter((b) => b.trigger === 'RECOVER')).toEqual([]);
    expect(h.alerts.map((a) => a.name)).toContain('channel_settle_outcome_mismatch');
  });

  it('L3: a collect LANDED but not booked (a stop in between) is re-booked from its receipt, never twice', async () => {
    const h = build({
      calls: [
        call(200n, { heldStatus: 'HELD', collectableAt: new Date((NOW - 100) * 1000) }),
        call(300n, { heldStatus: 'HELD', collectableAt: new Date((NOW - 50) * 1000) }),
      ],
      unbooked: [
        {
          id: 'tx-9',
          kind: 'COLLECT',
          txRefs: ['0xcollected'],
          channelRowIds: ['lane-1'],
          createdAt: new Date((NOW - 900) * 1000),
        },
      ],
      // One call of the 200 paid was booked before the stop.
      collectedByTx: 100n,
    });
    h.door.txReceipt = jest.fn(async () => ({
      state: 'MINED',
      success: true,
      txRef: '0xcollected',
      landedAt: NOW - 800,
      settled: [],
      collected: [{ key: KEY, provider: PROVIDER, maturityHour: HOUR - 1, gross: 200n, fee: 20n }],
      collectSkipped: [],
      deferred: [],
      refunded: [],
      refundSkipped: [],
    }));
    await h.service.run(ASSET as never);
    // Only the remaining 100 is attributed: one call, not two.
    expect(h.intents.bookHeldCollected).toHaveBeenCalledTimes(1);
    expect(h.intents.bookHeldCollected).toHaveBeenCalledWith('org', 'i200', '0xcollected');
    expect(h.txBooked).toEqual(['tx-9']);
  });

  it('R-2: the age is wall-clock age even when the chain clock runs ahead (no false hard cap)', async () => {
    const DRIFT = 7_200; // the chain 2 h ahead of the wall clock
    const chainVoucher = {
      ...VOUCHER,
      issuedAt: String(NOW + DRIFT - 30),
      expiresAt: String(NOW + DRIFT + 200),
    };
    const fresh = build({
      calls: [call(200n), call(300n)], // admitted 60 s ago (wall)
      vouchers: [chainVoucher],
    });
    fresh.door.chainNow = async () => NOW + DRIFT;
    await fresh.service.run(ASSET as never);
    expect(fresh.bound).toEqual([]);
    expect(fresh.alerts.map((a) => a.name)).not.toContain('channel_unsettled_old');

    const aged = build({
      calls: [call(200n, { createdAt: AGED }), call(300n, { createdAt: AGED })], // 30 min (wall)
      vouchers: [chainVoucher],
    });
    aged.door.chainNow = async () => NOW + DRIFT;
    await aged.service.run(ASSET as never);
    expect(aged.bound[0]).toMatchObject({ trigger: 'AGE' });
  });

  it('R2 (M1): provider risk (slash pending) settles on the URGENT lane', async () => {
    const h = build({ calls: [call(200n), call(300n)], risk: { slashPending: true } });
    await h.service.run(ASSET as never);
    expect(h.sent).toEqual([{ kind: 'settle', lane: 'URGENT', items: 1 }]);
  });

  it('R2b (M1): a SLASH urgent request goes URGENT too (urgent outranks provider risk)', async () => {
    const h = build({
      lanes: [lane({ urgentRequestedAt: new Date(NOW * 1000), urgentReason: 'SLASH' })],
      calls: [call(200n), call(300n)],
    });
    await h.service.run(ASSET as never);
    expect(h.sent).toEqual([{ kind: 'settle', lane: 'URGENT', items: 1 }]);
  });

  it('R4 (M2): a VERIFYING call at T_term is settled as served/unverified, not voided', async () => {
    const h = build({
      calls: [call(200n, { status: 'VERIFYING', createdAt: new Date((NOW - 301) * 1000) })],
    });
    await h.service.run(ASSET as never);
    expect(h.intents.resolve).toHaveBeenCalledWith(
      'org',
      'i200',
      'VERIFYING',
      'SETTLED',
      expect.objectContaining({ reason: 'channel_terminal_timeout_unverified' }),
    );
    expect(h.intents.resolve).not.toHaveBeenCalledWith(
      'org',
      'i200',
      'VERIFYING',
      'VOIDED',
      expect.anything(),
    );
  });
});

describe('W2 review regressions: R3 (H1) a channel refund is idempotent per call', () => {
  function refundHarness() {
    let h1 = 500n; // bucket: 5 calls of 100, one disputed
    const sent: bigint[] = [];
    const txs = new Map<string, any>();
    let receipt: any = { state: 'PENDING' };
    let confirmed = 0n;
    let block = 100n;
    const locks = new Set<string>();
    const attempts = new Map<string, { sender: string; nonce: bigint }>();
    const door = {
      readBooks: async () => ({
        slot: { ...EMPTY_SLOT, settled: 500n, h1, m1: HOUR + 1, r1: 1_000 },
        unpaid: 0n,
        totalUnpaid: 0n,
        held: h1,
      }),
      chainNow: async () => NOW,
      txReceipt: jest.fn(async () => receipt),
      confirmedNonce: jest.fn(async () => confirmed),
      latestBlock: jest.fn(async () => block),
      refund: jest.fn(async (_a: unknown, items: any[], opts: any) => {
        await opts?.beforeBroadcast?.(`0xr${sent.length}`, {
          from: `0x${'90'.repeat(20)}`,
          nonce: BigInt(sent.length),
        });
        h1 -= items[0].amount; // lands on chain
        sent.push(items[0].amount);
        if (sent.length === 1) throw new Error('Timed out while waiting for transaction receipt');
        return {
          txRef: `0xr${sent.length - 1}`,
          landedAt: NOW,
          refunded: [{ key: KEY, amount: items[0].amount }],
          skipped: [],
        };
      }),
    };
    const channels = {
      findById: async () => lane(),
      setStatus: jest.fn(async () => undefined),
      findLiveRefund: async (intentId: string) =>
        [...txs.values()].find(
          (t) => t.intentId === intentId && ['PENDING', 'SENT', 'LANDED'].includes(t.status),
        ) ?? null,
      insertTx: async (input: any) => {
        const live = [...txs.values()].find(
          (t) => t.intentId === input.intentId && ['PENDING', 'SENT', 'LANDED'].includes(t.status),
        );
        if (live) return null;
        const id = `tx${txs.size}`;
        txs.set(id, {
          id,
          ...input,
          txRefs: [],
          status: 'PENDING',
          createdAt: new Date(Date.now()),
        });
        return id;
      },
      appendTxRef: async (id: string, hash: string) => {
        const tx = txs.get(id);
        tx.txRefs.push(hash);
        tx.status = 'SENT';
      },
      finishTx: async (
        id: string,
        status: string,
        _detail: string | null,
        txRef?: string,
        amount?: bigint,
      ) => {
        const tx = txs.get(id);
        if (!['PENDING', 'SENT'].includes(tx.status)) return;
        tx.status = status;
        if (amount !== undefined && amount !== null) tx.amount = amount;
        if (txRef && !tx.txRefs.includes(txRef)) tx.txRefs.push(txRef);
      },
      // Every record of the call (its refund pieces, final review MF-1).
      refundRecords: async (intentId: string) =>
        [...txs.values()].filter((t) => t.intentId === intentId),
      recordAttempt: async (hash: string, sender: string, nonce: bigint) =>
        void attempts.set(hash, { sender, nonce }),
      // One owner per call (F1), as `pg_try_advisory_xact_lock` gives it.
      withRefundLock: async (intentId: string, work: () => Promise<unknown>) => {
        if (locks.has(intentId)) return null;
        locks.add(intentId);
        try {
          return await work();
        } finally {
          locks.delete(intentId);
        }
      },
      noteDropSeen: async (id: string, at: bigint) => {
        const tx = txs.get(id);
        tx.dropSeenBlock = tx.dropSeenBlock ?? at;
        return tx.dropSeenBlock as bigint;
      },
      attemptsOf: async (hashes: string[]) =>
        new Map(hashes.filter((h) => attempts.has(h)).map((h) => [h, attempts.get(h)!] as const)),
    };
    let clock = Date.now();
    const service = new ChannelRefundService(channels as never, door as never, () => clock);
    return {
      advance: (seconds: number) => void (clock += seconds * 1000),
      service,
      sent,
      door,
      txs,
      bucket: () => h1,
      setReceipt: (r: any) => (receipt = r),
      setConfirmed: (n: bigint) => (confirmed = n),
      setBlock: (n: bigint) => (block = n),
      age: (seconds: number) => {
        for (const tx of txs.values()) tx.createdAt = new Date(Date.now() - seconds * 1000);
      },
    };
  }
  const input = { assetId: ASSET, channelRowId: 'lane-1', amount: 100n, intentId: 'i-disputed' };

  it('a retry after an unknown outcome sends nothing new while the first is unresolved', async () => {
    const h = refundHarness();
    await expect(h.service.refund(input)).rejects.toThrow(); // the dispute job retries
    const second = await h.service.refund(input);
    expect(second.kind).toBe('NOT_FOUND');
    expect(h.sent).toEqual([100n]);
    expect(h.bucket()).toBe(400n); // exactly the one disputed call left the bucket
  });

  it('once the first is mined with ChannelRefunded, the retry books it — still one send', async () => {
    const h = refundHarness();
    await expect(h.service.refund(input)).rejects.toThrow();
    h.setReceipt({
      state: 'MINED',
      success: true,
      txRef: '0xr0',
      landedAt: NOW,
      settled: [],
      collected: [],
      collectSkipped: [],
      deferred: [],
      refunded: [
        { key: KEY, payer: PAYER, maturityHour: HOUR + 1, takeRateBps: 1_000, amount: 100n },
      ],
      refundSkipped: [],
    });
    const second = await h.service.refund(input);
    expect(second).toEqual({ kind: 'REFUNDED', txRef: '0xr0' });
    expect(h.sent).toEqual([100n]);
    // A third call answers from the landed record.
    expect(await h.service.refund(input)).toEqual({ kind: 'REFUNDED', txRef: '0xr0' });
    expect(h.sent).toEqual([100n]);
  });

  it('an unknown first send an hour old is still not re-sent while its nonce is unused', async () => {
    const h = refundHarness();
    await expect(h.service.refund(input)).rejects.toThrow();
    h.setReceipt({ state: 'UNKNOWN' });
    h.age(3_600);
    h.setConfirmed(0n); // nonce 0 not used
    expect((await h.service.refund(input)).kind).toBe('NOT_FOUND');
    expect(h.sent).toEqual([100n]);
  });

  it('re-sent only once the confirmed nonce passed it with no receipt, at TWO different blocks (F2)', async () => {
    const h = refundHarness();
    await expect(h.service.refund(input)).rejects.toThrow();
    h.setReceipt({ state: 'UNKNOWN' });
    h.setConfirmed(1n); // nonce 0 used by another transaction
    // First "dropped" verdict: noted, not acted on.
    expect((await h.service.refund(input)).kind).toBe('NOT_FOUND');
    expect(h.sent).toEqual([100n]);
    // Same block again: still not.
    expect((await h.service.refund(input)).kind).toBe('NOT_FOUND');
    // A later block, still dropped, but under 30 s since the first verdict: not yet (M-1).
    h.setBlock(101n);
    h.advance(10);
    expect((await h.service.refund(input)).kind).toBe('NOT_FOUND');
    expect(h.sent).toEqual([100n]);
    // Held for 30 s at a later block: sent again (the chain skips a reused refundId anyway).
    h.advance(20);
    expect(await h.service.refund(input)).toEqual({ kind: 'REFUNDED', txRef: '0xr1' });
    expect(h.sent).toEqual([100n, 100n]);
  });

  it('M-1: an IN_FLIGHT answer between two DROPPED verdicts starts the 30 s wait over', async () => {
    const h = refundHarness();
    await expect(h.service.refund(input)).rejects.toThrow();
    h.setReceipt({ state: 'UNKNOWN' });
    h.setConfirmed(1n);
    expect((await h.service.refund(input)).kind).toBe('NOT_FOUND'); // first sighting
    h.setConfirmed(0n); // a lagging node: the nonce looks unused again
    h.advance(20);
    h.setBlock(101n);
    expect((await h.service.refund(input)).kind).toBe('NOT_FOUND');
    h.setConfirmed(1n);
    h.advance(20); // 40 s after the first sighting, 0 s after the reset
    h.setBlock(102n);
    expect((await h.service.refund(input)).kind).toBe('NOT_FOUND');
    expect(h.sent).toEqual([100n]);
  });

  it('M-1: every send carries refundId = keccak256(intentId), the same on a re-send', async () => {
    const h = refundHarness();
    await expect(h.service.refund(input)).rejects.toThrow();
    h.setReceipt({ state: 'UNKNOWN' });
    h.setConfirmed(1n);
    await h.service.refund(input);
    h.setBlock(101n);
    h.advance(30);
    await h.service.refund(input);
    const ids = h.door.refund.mock.calls.map((c: any[]) => c[1][0].refundId);
    expect(ids).toEqual([channelRefundId('i-disputed'), channelRefundId('i-disputed')]);
  });

  it('M-1: a re-send the chain answers AlreadyRefunded is booked LANDED from the landing log, never sent again', async () => {
    const h = refundHarness();
    await expect(h.service.refund(input)).rejects.toThrow(); // landed, but read as dropped below
    h.setReceipt({ state: 'UNKNOWN' }); // a lagging node
    h.setConfirmed(1n);
    await h.service.refund(input);
    h.setBlock(101n);
    h.advance(30);
    h.door.refund.mockImplementationOnce(async (_a: unknown, _items: any[], opts: any) => {
      await opts.beforeBroadcast('0xr1', { from: `0x${'90'.repeat(20)}`, nonce: 1n });
      return {
        txRef: '0xr1',
        landedAt: NOW,
        refunded: [],
        skipped: [{ key: KEY, reason: 'AlreadyRefunded', amount: 100n }],
      };
    });
    (h.door as any).findRefundLanding = jest.fn(async () => ({ txRef: '0xr0', blockNumber: 90n }));
    expect(await h.service.refund(input)).toEqual({ kind: 'REFUNDED', txRef: '0xr0' });
    expect((h.door as any).findRefundLanding).toHaveBeenCalledWith(
      ASSET,
      KEY,
      channelRefundId('i-disputed'),
      expect.any(BigInt),
    );
    expect(h.bucket()).toBe(400n); // the chain moved the money once
    const landed = [...h.txs.values()].filter((t) => t.status === 'LANDED');
    expect(landed).toHaveLength(1);
    // Answered from the LANDED record (its landing hash) from now on: no third send.
    expect(await h.service.refund(input)).toEqual({ kind: 'REFUNDED', txRef: '0xr0' });
    expect(h.door.refund).toHaveBeenCalledTimes(2);
  });

  it('M-1: AlreadyRefunded with no landing log found is still LANDED (noted for the reconciler)', async () => {
    const h = refundHarness();
    h.door.refund.mockImplementationOnce(async (_a: unknown, _items: any[], opts: any) => {
      await opts.beforeBroadcast('0xr7', { from: `0x${'90'.repeat(20)}`, nonce: 0n });
      return {
        txRef: '0xr7',
        landedAt: NOW,
        refunded: [],
        skipped: [{ key: KEY, reason: 'AlreadyRefunded', amount: 100n }],
      };
    });
    (h.door as any).findRefundLanding = jest.fn(async () => null);
    expect(await h.service.refund(input)).toEqual({ kind: 'REFUNDED', txRef: '0xr7' });
    const tx = [...h.txs.values()][0];
    expect(tx.status).toBe('LANDED');
  });

  it('M-1: a mined earlier send whose receipt says AlreadyRefunded is LANDED on read-back', async () => {
    const h = refundHarness();
    await expect(h.service.refund(input)).rejects.toThrow();
    h.setReceipt({
      state: 'MINED',
      success: true,
      txRef: '0xr0',
      landedAt: NOW,
      settled: [],
      collected: [],
      collectSkipped: [],
      deferred: [],
      refunded: [],
      refundSkipped: [{ key: KEY, reason: 'AlreadyRefunded', amount: 100n }],
    });
    expect((await h.service.refund(input)).kind).toBe('REFUNDED');
    expect(h.sent).toEqual([100n]);
  });

  it('F1: a concurrent caller while the first refund is still being sent sends nothing', async () => {
    const h = refundHarness();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    h.door.refund.mockImplementationOnce(async (_a: unknown, items: any[], opts: any) => {
      await gate; // in prepare / the relayer queue, past any timer
      await opts.beforeBroadcast('0xslow', { from: `0x${'90'.repeat(20)}`, nonce: 0n });
      h.sent.push(items[0].amount);
      return {
        txRef: '0xslow',
        landedAt: NOW,
        refunded: [{ key: KEY, amount: 100n }],
        skipped: [],
      };
    });
    const first = h.service.refund(input);
    // The dispute job and the blocked-provider pass race in: neither sends.
    await Promise.resolve();
    expect(await h.service.refund(input)).toEqual({
      kind: 'NOT_FOUND',
      reason: 'a refund of this call is in flight',
    });
    releaseFirst();
    expect(await first).toEqual({ kind: 'REFUNDED', txRef: '0xslow' });
    expect(h.sent).toEqual([100n]);
    expect(h.door.refund).toHaveBeenCalledTimes(1);
  });

  it('F1: a stale record of an owner that died before beforeBroadcast is dropped and re-sent', async () => {
    const h = refundHarness();
    h.door.refund.mockImplementationOnce(async () => {
      throw new Error('process crashed before signing');
    });
    await expect(h.service.refund(input)).rejects.toThrow();
    // No hash, lock free: never broadcast, so a new owner may send.
    h.door.refund.mockImplementationOnce(async (_a: unknown, items: any[]) => ({
      txRef: '0xr9',
      landedAt: NOW,
      refunded: [{ key: KEY, amount: items[0].amount }],
      skipped: [],
    }));
    expect(await h.service.refund(input)).toEqual({ kind: 'REFUNDED', txRef: '0xr9' });
  });

  it('a first send that definitely did not go out is retried', async () => {
    const h = refundHarness();
    h.door.refund
      .mockImplementationOnce(async () => {
        throw new ChannelNotSentError('refused before broadcast');
      })
      .mockImplementationOnce(async (_a: unknown, items: any[]) => ({
        txRef: '0xr1',
        landedAt: NOW,
        refunded: [{ key: KEY, amount: items[0].amount }],
        skipped: [],
      }));
    await expect(h.service.refund(input)).rejects.toThrow();
    // Not sent: the record was released, so the retry sends again, and lands.
    expect([...h.txs.values()][0].status).toBe('DROPPED');
    expect(await h.service.refund(input)).toEqual({ kind: 'REFUNDED', txRef: '0xr1' });
    expect(h.door.refund).toHaveBeenCalledTimes(2);
  });
});

describe('W2 review regressions: lapse classification (H3)', () => {
  const expired = [{ ...VOUCHER, issuedAt: String(NOW - 9_000), expiresAt: String(NOW - 8_000) }];

  it.each([
    ['Stake', 'provider_forfeit:ChannelStake'],
    ['Blocked:PROVIDER', 'provider_forfeit:ChannelBlocked:PROVIDER'],
    ['PROVIDER_BLOCKED', 'provider_forfeit:ChannelPROVIDER_BLOCKED'],
  ])('a provider-caused lapse (%s) releases the buyer hold, no debt', async (reason, mark) => {
    const h = build({
      lanes: [lane({ lastSkipReason: reason })],
      calls: [call(200n), call(300n)],
      vouchers: expired,
    });
    await h.service.run(ASSET as never);
    expect(h.lapsed).toEqual([]);
    expect(h.closed).toEqual([{ ids: ['i200', 'i300'], mark }]);
    expect(h.intents.releaseHold).toHaveBeenCalledTimes(2);
  });

  it.each([null, 'SEND_FAILED', 'NoBucket', 'Expired', 'BaseMismatch', 'DEFERRED'])(
    'a platform-caused lapse (%s) is voided, no debt',
    async (reason) => {
      const h = build({
        lanes: [lane({ lastSkipReason: reason })],
        calls: [call(200n)],
        vouchers: expired,
      });
      await h.service.run(ASSET as never);
      expect(h.lapsed).toEqual([]);
      expect(h.closed[0].mark).toBe(`voided:CHANNEL_${reason ?? 'UNSETTLED'}`);
    },
  );

  it.each([
    'Balance',
    'EscrowWindow',
    'DelegateWindow',
    'PerCallCap',
    'Authority',
    'PAYER_BLOCKED',
  ])('only a buyer-caused lapse (%s) becomes buyer debt', async (reason) => {
    const h = build({
      lanes: [lane({ lastSkipReason: reason })],
      calls: [call(200n)],
      vouchers: expired,
    });
    await h.service.run(ASSET as never);
    expect(h.closed).toEqual([]);
    expect(h.lapsed).toEqual([{ ids: ['i200'], cause: `ChannelVoucherExpired:${reason}` }]);
  });

  describe('rev3 L-1: no lapse while the chain is unread or ahead of the DB', () => {
    const buyerLane = () => [lane({ lastSkipReason: 'Balance' })];

    it('the chain books cannot be read: nothing lapses this pass', async () => {
      const h = build({ lanes: buyerLane(), calls: [call(200n)], vouchers: expired });
      h.door.readBooks = async () => {
        throw new Error('rpc down');
      };
      await h.service.run(ASSET as never);
      expect(h.lapsed).toEqual([]);
      expect(h.closed).toEqual([]);
    });

    it('no channel door answer (null books): nothing lapses', async () => {
      const h = build({ lanes: buyerLane(), calls: [call(200n)], vouchers: expired });
      h.door.readBooks = async () => null;
      await h.service.run(ASSET as never);
      expect(h.lapsed).toEqual([]);
    });

    it('the chain settled past the DB to a value no voucher has (NO_VOUCHER): CRITICAL, nothing lapses', async () => {
      const h = build({
        lanes: buyerLane(),
        calls: [call(200n), call(300n)],
        vouchers: expired,
        slot: { ...EMPTY_SLOT, settled: 250n },
      });
      await h.service.run(ASSET as never);
      expect(h.alerts.map((a) => a.name)).toContain('channel_chain_ahead_unknown');
      expect(h.lapsed).toEqual([]);
      expect(h.closed).toEqual([]);
    });

    it('the chain settled past the DB, AMBIGUOUS: nothing lapses', async () => {
      const h = build({
        lanes: buyerLane(),
        calls: [call(200n), call(300n)],
        vouchers: expired,
        slot: { ...EMPTY_SLOT, settled: 300n },
        releasedTo: [
          { id: 'a', chargedIntentIds: ['i200'], txRefs: ['0xa'] },
          { id: 'b', chargedIntentIds: ['i200', 'i300'], txRefs: ['0xb'] },
        ],
      });
      await h.service.run(ASSET as never);
      expect(h.lapsed).toEqual([]);
    });

    it('chain and DB agree: the buyer lapse still happens (control)', async () => {
      const h = build({ lanes: buyerLane(), calls: [call(200n)], vouchers: expired });
      await h.service.run(ASSET as never);
      expect(h.lapsed).toEqual([{ ids: ['i200'], cause: 'ChannelVoucherExpired:Balance' }]);
    });
  });

  it('rev3 L-3: recoverAhead where the bound calls charge more than the chain step: CRITICAL, not booked, no lapse', async () => {
    const h = build({
      lanes: [lane({ lastSkipReason: 'Balance' })],
      calls: [call(200n, { price: 150n }), call(300n)],
      vouchers: [{ ...expired[0], id: 'v2', cumulative: '200', calls: 2 }],
      slot: { ...EMPTY_SLOT, settled: 200n },
    });
    await h.service.run(ASSET as never);
    expect(h.bound.filter((b) => b.trigger === 'RECOVER')).toEqual([]);
    const alert = h.alerts.find((a) => a.name === 'channel_settle_outcome_mismatch');
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe('CRITICAL');
    expect(JSON.stringify(alert)).toContain('CHARGE_ABOVE_STEP');
    expect(h.lapsed).toEqual([]);
  });

  it('a skip records its reason for the classification; Blocked is split by side', async () => {
    const h = build({ calls: [call(200n, { createdAt: AGED }), call(300n)], risk: {} });
    h.door.simulateSettle = async (_a: unknown, items: any[]) =>
      items.map((item, index) => ({
        kind: 'SKIPPED',
        index,
        key: null,
        cumulative: item.voucher.cumulative,
        reason: 'Blocked',
      }));
    await h.service.run(ASSET as never);
    expect(h.skips).toContainEqual({ id: 'lane-1', reason: 'Blocked:PAYER' });
  });
});

describe('W2 review regressions: the platform blocklist on channels (H3/H4)', () => {
  const providerBlocked = (parties: any[]) =>
    parties.find((p) => p.role === BlockedRole.PROVIDER)
      ? { role: BlockedRole.PROVIDER, hit: {} }
      : null;
  const payerBlocked = (parties: any[]) =>
    parties.find((p) => p.role === BlockedRole.PAYER) ? { role: BlockedRole.PAYER, hit: {} } : null;

  it('a blocked provider is never settled or collected; its held calls are refunded, unsettled forfeited', async () => {
    const matured = new Date((NOW - 3_600) * 1000);
    const h = build({
      blocked: providerBlocked,
      slot: { ...EMPTY_SLOT, settled: 100n, h1: 100n, m1: HOUR - 1, r1: 1_000 },
      calls: [
        call(100n, { heldStatus: 'HELD', collectableAt: matured, intentId: 'held' }),
        call(200n, { createdAt: AGED }),
        call(300n, { createdAt: AGED }),
      ],
    });
    await h.service.run(ASSET as never);
    expect(h.sent).toEqual([]);
    expect(h.refunds.refund).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: 'held', amount: 100n }),
    );
    expect(h.intents.bookBlockedProviderRefund).toHaveBeenCalledWith(
      'org',
      'held',
      'ProviderBlocked',
      '0xrefund',
    );
    expect(h.closed).toContainEqual({
      ids: ['i200', 'i300'],
      mark: 'provider_forfeit:ProviderBlocked',
    });
  });

  it('a blocked payer is not settled (its lapse would be its own debt)', async () => {
    const h = build({
      blocked: payerBlocked,
      calls: [call(200n, { createdAt: AGED }), call(300n, { createdAt: AGED })],
    });
    await h.service.run(ASSET as never);
    expect(h.sent).toEqual([]);
    expect(h.skips).toContainEqual({ id: 'lane-1', reason: 'PAYER_BLOCKED' });
    expect(h.closed).toEqual([]);
  });
});

describe('W2 review regressions: booking from the bind (H2, L1, L2)', () => {
  it('lands exactly the calls bound as charged, even if one was upheld after the bind', async () => {
    const rows = [
      call(200n, { createdAt: AGED, settlementId: 'settlement-1' }),
      call(300n, { createdAt: AGED, settlementId: 'settlement-1' }),
    ];
    const h = build({
      calls: () => rows,
      // A dispute is upheld between the bind and the landing.
      onBind: () => Object.assign(rows[0], { disputeOutcome: 'UPHELD' }),
    });
    await h.service.run(ASSET as never);
    expect(h.bound[0].chargedIntentIds).toEqual(['i200', 'i300']);
    expect(h.booked).toEqual(['i200', 'i300']);
    // Its buyer hold is NOT released here: the uphold is refunded on chain.
    expect(h.intents.releaseHold).not.toHaveBeenCalled();
  });

  it('an outcome whose key or cumulative is not the plan’s is not booked (CRITICAL)', async () => {
    const h = build({ calls: [call(200n, { createdAt: AGED }), call(300n, { createdAt: AGED })] });
    h.door.settle = async (_a: unknown, items: any[]) => ({
      txRef: '0xabc',
      landedAt: NOW,
      outcomes: items.map((item, i) => ({
        ...settledOutcome(item, i),
        key: `0x${'0d'.repeat(32)}`,
      })),
    });
    await h.service.run(ASSET as never);
    expect(h.booked).toEqual([]);
    expect(h.alerts.find((a) => a.name === 'channel_settle_outcome_mismatch')?.severity).toBe(
      AlertSeverity.CRITICAL,
    );
  });
});

describe('W2 review regressions: collect, lanes, alerts (M5, M6)', () => {
  it('a collect put off by fees keeps that channel out of a non-deadline settle', async () => {
    const matured = new Date((NOW - 3_600) * 1000);
    const h = build({
      slot: { ...EMPTY_SLOT, settled: 100n, h1: 100n, m1: HOUR - 1, r1: 1_000 },
      calls: [
        call(100n, { heldStatus: 'HELD', collectableAt: matured }),
        call(200n, { createdAt: AGED }),
        call(300n, { createdAt: AGED }),
      ],
    });
    h.door.collect = async () => {
      throw new ChannelSendDeferredError('fee spike');
    };
    await h.service.run(ASSET as never);
    expect(h.sent.filter((s) => s.kind === 'settle')).toEqual([]);
  });

  it('per-channel alerts are aggregated per asset and reason, with a count', async () => {
    const h = build({
      lanes: [lane(), lane({ id: 'lane-2', channelKey: `0x${'0e'.repeat(32)}` })],
      calls: [call(200n, { createdAt: AGED }), call(300n)],
    });
    h.door.simulateSettle = async (_a: unknown, items: any[]) =>
      items.map((item, index) => ({
        kind: 'SKIPPED',
        index,
        key: null,
        cumulative: item.voucher.cumulative,
        reason: 'Balance',
      }));
    await h.service.run(ASSET as never);
    const skipped = h.alerts.filter((a) => a.name === 'channel_settle_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].details.count).toBe(2);
  });
});

describe('W2 review regressions: pure rules', () => {
  it('laneOfTrigger: provider risk, urgent and hard cap are URGENT; deadline its own lane', () => {
    expect(laneOfTrigger('PROVIDER_RISK')).toBe('URGENT');
    expect(laneOfTrigger('URGENT')).toBe('URGENT');
    expect(laneOfTrigger('HARD_CAP')).toBe('URGENT');
    expect(laneOfTrigger('DEADLINE')).toBe('DEADLINE');
    expect(laneOfTrigger('AGE')).toBe('ORDINARY');
    expect(laneOfTrigger('PIGGYBACK')).toBe('ORDINARY');
  });

  it('decideRound: an urgent request outranks provider risk and the amount trigger', () => {
    const decision = decideRound(
      [
        {
          channelRowId: 'c',
          payer: 'p',
          provider: 'q',
          pendingAtomic: 10_000_000n,
          oldestUnsettledAt: NOW - 10,
          deadline: null,
          settling: false,
          providerRisk: true,
        },
      ],
      NOW,
      DEFAULT_CHANNEL_POLICY,
      new Set(['c']),
    );
    expect(decision.triggers.get('c')).toBe('URGENT');
  });

  it('classifyLapse: unknown reasons are the platform’s', () => {
    expect(classifyLapse('Stake')).toBe('PROVIDER');
    expect(classifyLapse('Balance')).toBe('BUYER');
    expect(classifyLapse('Unknown(99)')).toBe('PLATFORM');
    expect(classifyLapse(null)).toBe('PLATFORM');
  });

  it('nextPayoutAtByDoor: never before the earliest hold end; per door', () => {
    const doors = {
      perCall: { ready: 0n, oldestReadyAt: null, holdEndsAt: NOW + 7_000 },
      channel: { ready: 0n, holdEndsAt: null, active: false },
    };
    // Per call: the hold end, then at most the 6 h gathering wait.
    expect(nextPayoutAtByDoor('EVERY_6_HOURS', doors, NOW, 25_000_000n, 21_600, 60)).toBe(
      NOW + 7_000 + 21_600,
    );
    // An active channel's matured bucket: the next tick after its hold ends.
    expect(
      nextPayoutAtByDoor(
        'EVERY_6_HOURS',
        { ...doors, channel: { ready: 0n, holdEndsAt: NOW + 3_600, active: true } },
        NOW,
        25_000_000n,
        21_600,
        60,
      ),
    ).toBe(NOW + 3_660);
    expect(
      nextPayoutAtByDoor(
        'HOURLY',
        { ...doors, perCall: { ready: 30_000_000n, oldestReadyAt: NOW - 60, holdEndsAt: null } },
        NOW + 10,
        25_000_000n,
        21_600,
        60,
      ),
    ).toBe(NOW + 3_600);
    expect(
      nextPayoutAtByDoor(
        'HOURLY',
        {
          perCall: { ready: 0n, oldestReadyAt: null, holdEndsAt: null },
          channel: { ready: 0n, holdEndsAt: null, active: false },
        },
        NOW,
        1n,
        21_600,
        60,
      ),
    ).toBeNull();
  });

  it('the boot check refuses CHANNEL_GLOBAL_RESERVATION=false (I1)', () => {
    expect(
      channelBootRefusal({
        ...DEFAULT_CHANNEL_POLICY,
        switches: { ...DEFAULT_CHANNEL_POLICY.switches, globalReservation: false },
      }),
    ).toMatch(/CHANNEL_GLOBAL_RESERVATION/);
  });

  it('mainnet keeps at most 4 open channels per payer whatever the env says (L2)', () => {
    expect(maxOpenChannelsOn('eip155:4663', 16)).toBe(4);
    expect(maxOpenChannelsOn('eip155:4663', 2)).toBe(2);
    expect(maxOpenChannelsOn('eip155:46630', 16)).toBe(16);
  });

  it('channelSendNotSent: only definite not-sent errors release', () => {
    expect(channelSendNotSent(new ChannelSendDeferredError('fees'))).toBe(true);
    expect(channelSendNotSent(new ChannelNotSentError('refused'))).toBe(true);
    expect(channelSendNotSent({ broadcast: false })).toBe(true);
    expect(channelSendNotSent({ errorCode: 'CHAIN_RELAY_NOT_SENT' })).toBe(true);
    expect(channelSendNotSent(new Error('Timed out while waiting for transaction'))).toBe(false);
  });
});

describe('W2 re-review F2: dropped is decided nonce FIRST, receipts after', () => {
  it('a transaction sequenced between the reads is not called dropped', async () => {
    const { droppedByNonce } = await import('@modules/payment/services/channel-tx-attempts');
    let nonceRead = false;
    const door = {
      // The tx lands just before the nonce read: the nonce has passed, and the
      // receipt exists by the time it is read AFTER the nonce.
      confirmedNonce: async () => {
        nonceRead = true;
        return 8n;
      },
      txReceipt: async () => (nonceRead ? { state: 'MINED' } : { state: 'UNKNOWN' }),
    };
    const channels = {
      attemptsOf: async () => new Map([['0xabc', { sender: `0x${'90'.repeat(20)}`, nonce: 7n }]]),
    };
    const verdict = await droppedByNonce(door as never, channels as never, ASSET as never, [
      '0xabc',
    ]);
    expect(verdict.verdict).toBe('IN_FLIGHT');
  });

  it('dropped only when the nonce passed AND no receipt after it', async () => {
    const { droppedByNonce } = await import('@modules/payment/services/channel-tx-attempts');
    const door = { confirmedNonce: async () => 8n, txReceipt: async () => ({ state: 'UNKNOWN' }) };
    const channels = {
      attemptsOf: async () => new Map([['0xabc', { sender: `0x${'90'.repeat(20)}`, nonce: 7n }]]),
    };
    expect(
      (await droppedByNonce(door as never, channels as never, ASSET as never, ['0xabc'])).verdict,
    ).toBe('DROPPED');
  });
});
