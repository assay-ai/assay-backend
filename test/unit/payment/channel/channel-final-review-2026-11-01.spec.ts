import { getAddress } from 'viem';

import { BlockedRole } from '@modules/blocklist/domain/account-block';
import { DEFAULT_CHANNEL_POLICY } from '@modules/payment/domain/channel/channel-policy';
import { channelRefundId } from '@modules/payment/domain/channel/channel-voucher';
import { ChannelSettlementService } from '@modules/payment/services/channel-settlement.service';
import {
  ChannelNotSentError,
  ChannelSendDeferredError,
} from '@modules/payment/ports/channel-door.port';

import {
  ASSET,
  CHAIN,
  ChainModel,
  GRID,
  HELD_TIMEOUT,
  PAYER,
  row,
  wire,
} from './helpers/channel-chain-model';

/**
 * Final pre-mainnet review 2026-11-01 (money flow MF-*, cross-layer X-1). The
 * REAL ChannelSettlementService / ChannelRefundService over a port of the
 * contract's collect and refund rules (`helpers/channel-chain-model.ts`).
 */
const H = 500_000; // an hour index (unix hour)
const R = 1_000; // 10% take rate

/** The MF-1 lane after two collects: D's kept 0.15 split 0.10 (m1) + 0.05 (m2). */
async function splitKeep() {
  const model = new ChainModel(
    { settled: 300_000n, calls: 3, h1: 250_000n, m1: H, r1: R, h2: 50_000n, m2: H + 1, r2: R },
    H * GRID,
  );
  const rows = [
    row('X', 100_000n, 100_000n, { collectableAt: new Date(H * GRID * 1000) }),
    row('D', 250_000n, 150_000n, {
      collectableAt: new Date(H * GRID * 1000),
      disputeOutcome: 'OPEN',
    }),
    row('Y', 300_000n, 50_000n, { collectableAt: new Date((H + 1) * GRID * 1000) }),
  ];
  const h = wire(model, rows);
  h.clock.chainNowRead = H * GRID + 5;
  model.execNow = H * GRID + 6;
  await h.settlement.run(ASSET as never);
  h.clock.chainNowRead = (H + 1) * GRID + 5;
  model.execNow = (H + 1) * GRID + 6;
  await h.settlement.run(ASSET as never);
  rows.find((r) => r.intentId === 'D')!.disputeOutcome = 'UPHELD';
  model.execNow = (H + 2) * GRID;
  h.clock.chainNowRead = model.execNow;
  return { model, rows, ...h };
}
const refundD = { assetId: ASSET, channelRowId: 'lane-1', amount: 150_000n, intentId: 'D' };

describe('MF-1 / X-1: an upheld refund whose kept money is split across both buckets', () => {
  it('is refunded in two pieces with distinct deterministic ids (newest bucket first)', async () => {
    const { model, refunds } = await splitKeep();
    expect([model.slot.h1, model.slot.h2]).toEqual([100_000n, 50_000n]);

    const out = await refunds.refund(refundD);

    expect(out.kind).toBe('REFUNDED');
    expect(model.balance).toBe(150_000n);
    expect(model.held).toBe(0n);
    // Piece 0 keeps today's single-piece id; piece 1 has its own.
    expect(model.refunded.has(channelRefundId('D'))).toBe(true);
    expect(model.refunded.size).toBe(2);
  });

  it('a partial landing is retried safely: the landed piece is not refunded again', async () => {
    const { model, refunds, door } = await splitKeep();
    const send = door.refund;
    let calls = 0;
    door.refund = async (...args: unknown[]) => {
      calls += 1;
      if (calls === 2) throw new ChannelSendDeferredError('the redeemer float is dry');
      return send(...args);
    };

    await expect(refunds.refund(refundD)).rejects.toThrow(/deferred/);
    expect(model.balance).toBe(50_000n); // piece 0 (newest bucket) landed

    const retry = await refunds.refund(refundD);
    expect(retry.kind).toBe('REFUNDED');
    expect(model.balance).toBe(150_000n);
    expect(model.held).toBe(0n);
    expect(model.refunded.size).toBe(2);
  });

  it('AlreadyRefunded on a piece books what that id landed, never refunding twice', async () => {
    // One bucket held D whole: piece 0 (0.15) landed, but its record was
    // (wrongly) released as dropped. The buckets now look split.
    const model = new ChainModel(
      { settled: 300_000n, calls: 3, h1: 250_000n, m1: H, r1: R, h2: 50_000n, m2: H + 1, r2: R },
      (H + 2) * GRID,
    );
    const rows = [
      row('D', 250_000n, 150_000n, {
        collectableAt: new Date(H * GRID * 1000),
        disputeOutcome: 'UPHELD',
      }),
    ];
    const { refunds, txs } = wire(model, rows);
    expect(model.refund(H, R, 150_000n, channelRefundId('D'))).toBeNull();
    txs.set('old', {
      id: 'old',
      kind: 'REFUND',
      intentId: 'D',
      channelRowIds: ['lane-1'],
      amount: 150_000n,
      pieceIndex: 0,
      txRefs: ['0xlost'],
      status: 'DROPPED',
      createdAt: new Date(0),
    });

    const out = await refunds.refund(refundD);

    expect(out.kind).toBe('REFUNDED');
    expect(model.balance).toBe(150_000n); // not 250_000
    expect(model.held).toBe(150_000n);
  });

  it('control: equal prices still refund out of one bucket', async () => {
    const model = new ChainModel(
      { settled: 300_000n, calls: 3, h1: 200_000n, m1: H, r1: R, h2: 100_000n, m2: H + 1, r2: R },
      H * GRID,
    );
    const rows = [
      row('D1', 100_000n, 100_000n, {
        collectableAt: new Date(H * GRID * 1000),
        disputeOutcome: 'OPEN',
      }),
      row('D2', 200_000n, 100_000n, {
        collectableAt: new Date(H * GRID * 1000),
        disputeOutcome: 'OPEN',
      }),
      row('Y', 300_000n, 100_000n, { collectableAt: new Date((H + 1) * GRID * 1000) }),
    ];
    const { settlement, refunds, clock } = wire(model, rows);
    clock.chainNowRead = (H + 1) * GRID + 5;
    model.execNow = (H + 1) * GRID + 6;
    await settlement.run(ASSET as never);
    rows[0].disputeOutcome = 'UPHELD';
    const out = await refunds.refund({
      assetId: ASSET,
      channelRowId: 'lane-1',
      amount: 100_000n,
      intentId: 'D1',
    });
    expect(out.kind).toBe('REFUNDED');
    expect(model.refunded).toEqual(new Set([channelRefundId('D1')]));
  });

  it('past the window the refund is TIMED_OUT, as before', async () => {
    const { model, refunds, clock } = await splitKeep();
    model.execNow = H * GRID + HELD_TIMEOUT;
    clock.chainNowRead = model.execNow;
    const out = await refunds.refund(refundD);
    expect(out.kind).toBe('TIMED_OUT');
    expect(model.balance).toBe(0n);
  });
});

describe('MF-2: the collect-first keep covers disputes maturing during the pass', () => {
  it('a disputed call whose bucket matures between chainNow and the tx stays in the bucket', async () => {
    const model = new ChainModel(
      { settled: 250_000n, calls: 2, h1: 100_000n, m1: H, r1: R, h2: 150_000n, m2: H + 1, r2: R },
      H * GRID,
    );
    const rows = [
      row('A', 100_000n, 100_000n, { collectableAt: new Date(H * GRID * 1000) }),
      row('D', 250_000n, 150_000n, {
        collectableAt: new Date((H + 1) * GRID * 1000),
        disputeOutcome: 'OPEN',
      }),
    ];
    const { settlement, refunds, clock } = wire(model, rows);
    clock.chainNowRead = (H + 1) * GRID - 5;
    model.execNow = (H + 1) * GRID + 2;
    await settlement.run(ASSET as never);
    // D is kept although it matured only after the pass-start read: nothing is
    // paid that pass (A only waits), never D.
    expect(model.provider).toBe(0n);
    expect(model.held).toBe(250_000n);
    // The next pass pays A and keeps D.
    clock.chainNowRead = (H + 1) * GRID + 60;
    model.execNow = (H + 1) * GRID + 61;
    await settlement.run(ASSET as never);
    expect(model.provider).toBe(90_000n);
    expect(model.held).toBe(150_000n);
    rows[1].disputeOutcome = 'UPHELD';
    const out = await refunds.refund({
      assetId: ASSET,
      channelRowId: 'lane-1',
      amount: 150_000n,
      intentId: 'D',
    });
    expect(out.kind).toBe('REFUNDED');
    expect(model.balance).toBe(150_000n);
  });

  it('FR-M2: a collect that mines long after the pass-start read still keeps the dispute', async () => {
    // D's bucket matures an hour after chainNow; the collect (a late batch, or
    // one whose receipt timed out) mines after that. No maturity cut-off may
    // let D be paid.
    const model = new ChainModel(
      { settled: 250_000n, calls: 2, h1: 100_000n, m1: H, r1: R, h2: 150_000n, m2: H + 1, r2: R },
      H * GRID,
    );
    const rows = [
      row('A', 100_000n, 100_000n, { collectableAt: new Date(H * GRID * 1000) }),
      row('D', 250_000n, 150_000n, {
        collectableAt: new Date((H + 1) * GRID * 1000),
        disputeOutcome: 'OPEN',
      }),
    ];
    const { settlement, clock } = wire(model, rows);
    clock.chainNowRead = H * GRID + 10;
    model.execNow = (H + 1) * GRID + 1_200;
    await settlement.run(ASSET as never);
    expect(model.provider).toBe(0n);
    expect(model.held).toBe(250_000n);
  });
});

describe('MF-4: a platform outage past a delegate validUntil is the platform’s', () => {
  const DELEGATE = getAddress(`0x${'dd'.repeat(20)}`);
  const T0 = 1_800_000_000;
  const EXP = T0 + 300;

  function scenario(delegate: boolean) {
    const V = EXP + 3_700; // delegate validUntil; D = min(EXP + 7200, V) = V
    const model = new ChainModel(
      { settled: 0n, calls: 0, h1: 0n, m1: 0, r1: 0, h2: 0n, m2: 0, r2: 0 },
      T0,
    );
    const rows = [
      row('c1', 100_000n, 100_000n, { heldStatus: null, createdAt: new Date(T0 * 1000) }),
      row('c2', 200_000n, 100_000n, { heldStatus: null, createdAt: new Date(T0 * 1000) }),
    ];
    const lapsed: string[] = [];
    const voided: string[] = [];
    let simulateSkip: string | null = null;
    let revoked = false;
    const h = wire(
      model,
      rows,
      {
        signer: `${CHAIN}:${delegate ? DELEGATE : PAYER}`,
        lastAcceptedCumulative: '200000',
        lastAcceptedCalls: 2,
        settledCumulative: '0',
        settledCalls: 0,
      },
      {
        channels: {
          vouchers: async () => [
            {
              id: 'v2',
              cumulative: '200000',
              calls: 2,
              issuedAt: String(T0),
              expiresAt: String(EXP),
              signature: `0x${'11'.repeat(65)}`,
            },
          ],
          bindSettlement: async () => 'settlement-1',
          markSent: async () => undefined,
          releaseSettlement: async () => undefined,
          lapse: async (_c: string, ids: string[]) => {
            lapsed.push(...ids);
            return ids.length;
          },
          closeUnsettled: async (_c: string, ids: string[]) => {
            voided.push(...ids);
            return [];
          },
        },
        door: {
          signerWindow: async () => ({
            validUntil: delegate ? V : null,
            revoked,
            revokeGraceEndsAt: null,
            heldCapsEndAt: null,
          }),
          simulateSettle: async (_a: unknown, items: any[]) =>
            items.map((item, index) =>
              simulateSkip
                ? {
                    kind: 'SKIPPED',
                    index,
                    key: null,
                    cumulative: item.voucher.cumulative,
                    reason: simulateSkip,
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
          settle: async () => {
            throw new ChannelSendDeferredError('the redeemer float cannot pay settleChannels');
          },
        },
      },
    );
    return {
      ...h,
      V,
      lapsed,
      voided,
      skip: (s: string | null) => {
        simulateSkip = s;
      },
      revoke: () => {
        revoked = true;
      },
    };
  }

  it('delegate lane: the outage spans validUntil → Authority → voided, not buyer debt', async () => {
    const s = scenario(true);
    s.clock.chainNowRead = s.V - 3_500;
    await s.settlement.run(ASSET as never);
    expect(s.laneRow.lastSkipReason).toBe('DEFERRED');
    s.clock.chainNowRead = s.V + 60;
    s.skip('Authority');
    await s.settlement.run(ASSET as never);
    expect(s.laneRow.status).toBe('REVOKED');
    s.clock.chainNowRead = EXP + 7_201;
    await s.settlement.run(ASSET as never);
    expect(s.lapsed).toEqual([]);
    expect(s.voided).toEqual(['c1', 'c2']);
  });

  it('a delegate the buyer revoked stays buyer debt (Authority, buyer side)', async () => {
    const s = scenario(true);
    s.revoke();
    s.clock.chainNowRead = s.V - 3_500;
    s.skip('Authority');
    await s.settlement.run(ASSET as never);
    expect(s.laneRow.lastSkipReason).toBe('Authority');
    s.clock.chainNowRead = EXP + 7_201;
    await s.settlement.run(ASSET as never);
    expect(s.lapsed).toEqual(['c1', 'c2']);
    expect(s.voided).toEqual([]);
  });

  it('control, payer-signed lane, same outage → platform VOID', async () => {
    const s = scenario(false);
    s.clock.chainNowRead = EXP + 3_700;
    await s.settlement.run(ASSET as never);
    expect(s.laneRow.lastSkipReason).toBe('DEFERRED');
    s.clock.chainNowRead = EXP + 7_201;
    await s.settlement.run(ASSET as never);
    expect(s.lapsed).toEqual([]);
    expect(s.voided).toEqual(['c1', 'c2']);
  });
});

describe('ops F2: a failing channel pass pages, and the deadline alert comes from the DB', () => {
  function failing() {
    const model = new ChainModel(
      { settled: 0n, calls: 0, h1: 0n, m1: 0, r1: 0, h2: 0n, m2: 0, r2: 0 },
      H * GRID,
    );
    let down = true;
    const h = wire(
      model,
      [],
      {},
      {
        door: {
          chainNow: async () => {
            if (down) throw new Error('rpc: 429 Too Many Requests');
            return H * GRID;
          },
        },
        channels: { nearDeadline: async () => [`0x${'0c'.repeat(32)}`] },
      },
    );
    return { ...h, up: () => (down = false) };
  }
  const named = (alerts: { name: string; severity: string }[], name: string) =>
    alerts.filter((a) => a.name === name);

  it('CRITICAL after 3 consecutive failed passes; a good pass resets the count', async () => {
    const h = failing();
    await h.settlement.run(ASSET as never);
    await h.settlement.run(ASSET as never);
    expect(named(h.alerts, 'channel_pass_failing')).toEqual([]);
    await h.settlement.run(ASSET as never);
    expect(named(h.alerts, 'channel_pass_failing')).toEqual([
      expect.objectContaining({ severity: 'CRITICAL' }),
    ]);
    h.up();
    await h.settlement.run(ASSET as never);
    h.alerts.length = 0;
    await h.settlement.run(ASSET as never);
    expect(named(h.alerts, 'channel_pass_failing')).toEqual([]);
  });

  it('channel_deadline_near is raised from voucher_channels.deadline_at when the pass fails early', async () => {
    const h = failing();
    await h.settlement.run(ASSET as never);
    expect(named(h.alerts, 'channel_deadline_near')).toEqual([
      expect.objectContaining({ severity: 'CRITICAL' }),
    ]);
  });

  it('a door that cannot be read counts as a failed pass', async () => {
    const h = failing();
    h.door.doorLive = async () => false;
    for (let i = 0; i < 3; i += 1) await h.settlement.run(ASSET as never);
    expect(named(h.alerts, 'channel_pass_failing')).toHaveLength(1);
  });
});

describe('ops F9 / E-1: channel send failures', () => {
  function collectable(collect: () => Promise<never>) {
    const model = new ChainModel(
      { settled: 100_000n, calls: 1, h1: 100_000n, m1: H, r1: R, h2: 0n, m2: 0, r2: 0 },
      H * GRID + 10,
    );
    const rows = [row('A', 100_000n, 100_000n, { collectableAt: new Date(H * GRID * 1000) })];
    return wire(model, rows, { lastAcceptedCumulative: '100000' }, { door: { collect } });
  }

  it('an unknown revert of a channel send pages CRITICAL', async () => {
    const h = collectable(async () => {
      throw new ChannelSendDeferredError('collectChannels would revert: UNKNOWN_REVERT:0xdeadbeef');
    });
    await h.settlement.run(ASSET as never);
    expect(h.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'CRITICAL', name: 'channel_send_unknown_revert' }),
      ]),
    );
  });

  it('a mined revert with no name pages CRITICAL too', async () => {
    const h = collectable(async () => {
      throw new ChannelNotSentError('collectChannels reverted: unknown (0xabc)', '0xabc');
    });
    await h.settlement.run(ASSET as never);
    expect(h.alerts.map((a) => [a.severity, a.name])).toContainEqual([
      'CRITICAL',
      'channel_send_unknown_revert',
    ]);
  });

  it('a named revert is reported (WARN), not swallowed as a deferral', async () => {
    const h = collectable(async () => {
      throw new ChannelSendDeferredError('collectChannels would revert: TransferGasTooLow');
    });
    await h.settlement.run(ASSET as never);
    expect(h.alerts.map((a) => [a.severity, a.name])).toContainEqual([
      'WARN',
      'channel_send_reverted',
    ]);
  });

  it('E-1: a multi-line viem error is trimmed to one line in channel_settle_outcome_unknown', async () => {
    const model = new ChainModel(
      { settled: 0n, calls: 0, h1: 0n, m1: 0, r1: 0, h2: 0n, m2: 0, r2: 0 },
      1_800_000_000,
    );
    const T0 = 1_800_000_000 - 200;
    const rows = [
      row('c1', 100_000n, 100_000n, { heldStatus: null, createdAt: new Date(T0 * 1000) }),
    ];
    const h = wire(
      model,
      rows,
      {
        lastAcceptedCumulative: '100000',
        lastAcceptedCalls: 1,
        settledCumulative: '0',
        settledCalls: 0,
        urgentRequestedAt: new Date(0),
        urgentReason: 'DRAIN',
      },
      {
        channels: {
          vouchers: async () => [
            {
              id: 'v1',
              cumulative: '100000',
              calls: 1,
              issuedAt: String(T0),
              expiresAt: String(T0 + 300),
              signature: `0x${'11'.repeat(65)}`,
            },
          ],
          bindSettlement: async () => 'settlement-1',
          markSent: async () => undefined,
          releaseSettlement: async () => undefined,
        },
        door: {
          simulateSettle: async (_a: unknown, items: any[]) =>
            items.map((item, index) => ({
              kind: 'SETTLED',
              index,
              key: '0x',
              cumulative: item.voucher.cumulative,
              calls: 1,
              charge: item.charge,
              maturityHour: 0,
              takeRateBps: 0,
              opened: null,
              deferred: null,
            })),
          settle: async (_a: unknown, _i: unknown, _l: unknown, opts: any) => {
            await opts.beforeBroadcast('0xhash', { from: `0x${'90'.repeat(20)}`, nonce: 1n });
            throw new Error(
              'Timed out while waiting for transaction with hash "0xhash" to be confirmed.\n\n' +
                'Request body: {"method":"eth_getTransactionReceipt"}\nVersion: viem@2.21.55',
            );
          },
        },
      },
    );
    await h.settlement.run(ASSET as never);
    const unknown = h.alerts.find((a) => a.name === 'channel_settle_outcome_unknown');
    expect(unknown).toBeDefined();
    expect(unknown!.summary).not.toMatch(/\n/);
    expect(unknown!.summary).not.toMatch(/Request body|Version: viem/);
  });
});

describe('contract L-1: a collect hold above one hour is paged', () => {
  it('raises channel_collect_hold_long with the runbook pointer', async () => {
    const model = new ChainModel(
      { settled: 0n, calls: 0, h1: 0n, m1: 0, r1: 0, h2: 0n, m2: 0, r2: 0 },
      H * GRID,
    );
    const h = wire(model, [], {}, { door: { collectHoldSeconds: async () => 86_400 } });
    await h.settlement.run(ASSET as never);
    const hold = h.alerts.find((a) => a.name === 'channel_collect_hold_long');
    expect(hold).toEqual(expect.objectContaining({ severity: 'WARN' }));
    expect(hold!.summary).toMatch(/runbook/i);
  });

  it('the default one-hour hold raises nothing', async () => {
    const model = new ChainModel(
      { settled: 0n, calls: 0, h1: 0n, m1: 0, r1: 0, h2: 0n, m2: 0, r2: 0 },
      H * GRID,
    );
    const h = wire(model, []);
    await h.settlement.run(ASSET as never);
    expect(h.alerts.find((a) => a.name === 'channel_collect_hold_long')).toBeUndefined();
  });
});

describe('MF-5: a stale last_skip_reason is cleared once nothing is left to settle', () => {
  it('a lane with nothing pending forgets its old skip reason', async () => {
    const model = new ChainModel(
      { settled: 100_000n, calls: 1, h1: 0n, m1: 0, r1: 0, h2: 0n, m2: 0, r2: 0 },
      H * GRID,
    );
    const h = wire(model, [], {
      lastAcceptedCumulative: '100000',
      lastAcceptedCalls: 1,
      settledCumulative: '100000',
      settledCalls: 1,
      lastSkipReason: 'EscrowWindow',
    });
    await h.settlement.run(ASSET as never);
    expect(h.laneRow.lastSkipReason).toBeNull();
  });
});

describe('MF-8: the blocked-provider refund reads the rows again after the collect', () => {
  it('a call collected this pass is not refunded out of another call’s bucket', async () => {
    // A (m1, matured) and B (m2, not matured), one lane; the provider is
    // blocked between the collect and the blocked-provider refund.
    const model = new ChainModel(
      { settled: 200_000n, calls: 2, h1: 100_000n, m1: H, r1: R, h2: 100_000n, m2: H + 1, r2: R },
      H * GRID + 10,
    );
    const rows = [
      row('A', 100_000n, 100_000n, { collectableAt: new Date(H * GRID * 1000) }),
      row('B', 200_000n, 100_000n, { collectableAt: new Date((H + 1) * GRID * 1000) }),
    ];
    const h = wire(model, rows, { lastAcceptedCumulative: '200000', settledCumulative: '200000' });
    let reads = 0;
    const blocklist = {
      // Unblocked while the collect pass looks; blocked from the refund pass on.
      firstBlocked: (subjects: { role: string }[]) => {
        if (subjects[0]?.role !== BlockedRole.PROVIDER) return null;
        reads += 1;
        return reads > 1 ? subjects[0] : null;
      },
    };
    const settlement = new ChannelSettlementService(
      h.channels,
      h.intents,
      h.door,
      { emit: async () => undefined } as never,
      new Set([CHAIN]),
      DEFAULT_CHANNEL_POLICY,
      null,
      () => (H * GRID + 10) * 1000,
      h.refunds,
      blocklist as never,
    );
    await settlement.run(ASSET as never);
    expect(rows[0].heldStatus).toBe('COLLECTED');
    // Only B is refunded, out of its own bucket.
    expect(model.refunded).toEqual(new Set([channelRefundId('B')]));
    expect(model.balance).toBe(100_000n);
  });
});

describe('MF-9: a take-rate change during a restart still drains', () => {
  it('the first pass compares the rate with the newest landed settlement', async () => {
    const T0 = H * GRID;
    const model = new ChainModel(
      { settled: 0n, calls: 0, h1: 0n, m1: 0, r1: 0, h2: 0n, m2: 0, r2: 0 },
      T0,
    );
    const rows = [
      row('c1', 100_000n, 100_000n, { heldStatus: null, createdAt: new Date(T0 * 1000) }),
    ];
    const bound: string[] = [];
    const h = wire(
      model,
      rows,
      {
        lastAcceptedCumulative: '100000',
        lastAcceptedCalls: 1,
        settledCumulative: '0',
        settledCalls: 0,
      },
      {
        channels: {
          lastLandedRate: async () => 500,
          vouchers: async () => [
            {
              id: 'v1',
              cumulative: '100000',
              calls: 1,
              issuedAt: String(T0),
              expiresAt: String(T0 + 240),
              signature: `0x${'11'.repeat(65)}`,
            },
          ],
          bindSettlement: async (input: { channelRowId: string }) => {
            bound.push(input.channelRowId);
            return null;
          },
        },
      },
    );
    await h.settlement.run(ASSET as never);
    expect(bound).toEqual(['lane-1']);
  });
});
