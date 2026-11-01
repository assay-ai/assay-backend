import {
  loadChannelPolicy,
  parseChannelLiveChains,
} from '@modules/payment/constants/channel.constants';
import {
  attributeCollect,
  ChannelPending,
  channelBootRefusal,
  channelDeadline,
  chooseSettlement,
  decideRound,
  DEFAULT_CHANNEL_POLICY,
  earliestRefundDeadline,
  maturedAmount,
  newestUsableExpiry,
  nextPayoutAt,
  payoutDue,
  placeCharge,
  refundBucket,
  reservationUrgent,
} from '@modules/payment/domain/channel/channel-policy';
import { EMPTY_SLOT } from '@modules/payment/domain/channel/channel-voucher';

const P = DEFAULT_CHANNEL_POLICY;
const NOW = 1_800_000_000; // a multiple of 3600? 1_800_000_000 / 3600 = 500000

function pending(overrides: Partial<ChannelPending> = {}): ChannelPending {
  return {
    channelRowId: 'c1',
    payer: 'payer',
    provider: 'provider',
    pendingAtomic: 100_000n,
    oldestUnsettledAt: NOW - 60,
    deadline: NOW + 7_000,
    settling: false,
    providerRisk: false,
    ...overrides,
  };
}

describe('channel policy — boot check (SPEC-W2 §6)', () => {
  it('accepts the defaults (30 min, collect hourly)', () => {
    expect(channelBootRefusal(P)).toBeNull();
    expect(loadChannelPolicy({}).tAgeSeconds).toBe(1_800);
  });

  it('refuses a slow cadence unless every safety is on', () => {
    const slow = { ...P, tAgeSeconds: 3_300 };
    expect(channelBootRefusal(slow)).toBeNull();
    expect(
      channelBootRefusal({ ...slow, switches: { ...P.switches, deadlineTrigger: false } }),
    ).toMatch(/deadlineTrigger/);
    expect(() =>
      loadChannelPolicy({ CHANNEL_T_AGE_SECONDS: '3300', CHANNEL_COLLECT_FIRST: 'false' }),
    ).toThrow(/collectFirst/);
    expect(() =>
      loadChannelPolicy({ CHANNEL_COLLECT_INTERVAL_SECONDS: '7200', CHANNEL_ALERTS: 'false' }),
    ).toThrow(/perChannelAlerts/);
    // A fast cadence may run with a switch off (e.g. a test).
    expect(loadChannelPolicy({ CHANNEL_ALERTS: 'false' }).switches.perChannelAlerts).toBe(false);
  });

  it('refuses a deadline margin below 3,600 s and a T_age above the 55-min hard cap', () => {
    expect(() => loadChannelPolicy({ CHANNEL_DEADLINE_MARGIN_SECONDS: '1800' })).toThrow();
    expect(() => loadChannelPolicy({ CHANNEL_T_AGE_SECONDS: '3600' })).toThrow();
  });

  it('the flag is off by default and only names eip155 chains', () => {
    expect(parseChannelLiveChains(undefined).size).toBe(0);
    expect([...parseChannelLiveChains('eip155:46630, solana:abc,')]).toEqual(['eip155:46630']);
  });
});

describe('channel policy — round triggers (v3 §5.4.3, SPEC-W2 §3)', () => {
  it('does not fire for a young channel; says when the next round is due', () => {
    const decision = decideRound([pending()], NOW, P);
    expect(decision.fire).toBe(false);
    expect(decision.nextAt).toBe(NOW - 60 + P.tAgeSeconds);
  });

  it('fires on age, and every pending channel joins (piggyback)', () => {
    const decision = decideRound(
      [
        pending({ oldestUnsettledAt: NOW - 1_800 }),
        pending({ channelRowId: 'c2' }),
        pending({ channelRowId: 'c3', pendingAtomic: 0n }),
      ],
      NOW,
      P,
    );
    expect(decision.fire).toBe(true);
    expect(decision.triggers.get('c1')).toBe('AGE');
    expect(decision.members).toEqual(['c1', 'c2']);
  });

  it('a fee spike postpones only the age trigger, up to the 55-min hard cap', () => {
    expect(
      decideRound([pending({ oldestUnsettledAt: NOW - 1_800 })], NOW, P, new Set(), true).fire,
    ).toBe(false);
    const hard = decideRound(
      [pending({ oldestUnsettledAt: NOW - 3_300 })],
      NOW,
      P,
      new Set(),
      true,
    );
    expect(hard.fire).toBe(true);
    expect(hard.triggers.get('c1')).toBe('HARD_CAP');
  });

  it('the deadline trigger fires at D − (U + O) and overrides a fee spike', () => {
    const decision = decideRound([pending({ deadline: NOW + 3_600 })], NOW, P, new Set(), true);
    expect(decision.fire).toBe(true);
    expect(decision.deadline).toBe(true);
    expect(decideRound([pending({ deadline: NOW + 3_601 })], NOW, P).fire).toBe(false);
  });

  it('fires on A_cap, on provider risk, and on an urgent request', () => {
    expect(decideRound([pending({ pendingAtomic: P.aCapAtomic })], NOW, P).triggers.get('c1')).toBe(
      'AMOUNT',
    );
    expect(decideRound([pending({ providerRisk: true })], NOW, P).triggers.get('c1')).toBe(
      'PROVIDER_RISK',
    );
    expect(decideRound([pending()], NOW, P, new Set(['c1'])).triggers.get('c1')).toBe('URGENT');
  });

  it('skips a channel with a settlement in flight', () => {
    expect(
      decideRound([pending({ settling: true, oldestUnsettledAt: NOW - 3_600 })], NOW, P).fire,
    ).toBe(false);
  });

  it('a withdrawal request is not a trigger: the channel waits for the next round (POLICY §2.1)', () => {
    // There is no withdrawal input to `decideRound` at all: only age, deadline,
    // amount, risk and urgent requests (debt replacement, reservation at 80%).
    expect(decideRound([pending()], NOW, P).fire).toBe(false);
  });

  it('D = min(expiresAt + 7200, validUntil, revoke-grace end, held-caps end)', () => {
    expect(
      channelDeadline({
        newestUsableExpiresAt: NOW,
        signerValidUntil: null,
        revokeGraceEndsAt: null,
        heldCapsEndAt: null,
      }),
    ).toBe(NOW + 7_200);
    expect(
      channelDeadline({
        newestUsableExpiresAt: NOW,
        signerValidUntil: NOW + 100,
        revokeGraceEndsAt: null,
        heldCapsEndAt: null,
      }),
    ).toBe(NOW + 100);
    expect(
      channelDeadline({
        newestUsableExpiresAt: null,
        signerValidUntil: null,
        revokeGraceEndsAt: null,
        heldCapsEndAt: null,
      }),
    ).toBeNull();
  });

  it('settles every pre-request voucher well before a withdrawal can mature', () => {
    // Voucher life ≤ 7,620 s after issue; settled by D − 3,600; withdraw delay 10,800 s.
    const issued = NOW;
    const deadlineTrigger = issued + 300 + 7_200 - P.deadlineMarginSeconds;
    expect(issued + 10_800 - deadlineTrigger).toBeGreaterThanOrEqual(6_600);
  });
});

describe('channel policy — voucher choice (v3 §5.4.4, I18)', () => {
  const vouchers = [
    { id: 'v1', cumulative: 100n, calls: 1, issuedAt: NOW - 600, expiresAt: NOW - 360 },
    { id: 'v2', cumulative: 200n, calls: 2, issuedAt: NOW - 300, expiresAt: NOW - 60 },
    { id: 'v3', cumulative: 300n, calls: 3, issuedAt: NOW - 10, expiresAt: NOW + 230 },
  ];
  const row = (cumulative: bigint, terminal = true, charged = true) => ({
    intentId: `i${cumulative}`,
    cumulative,
    price: 100n,
    terminal,
    charged,
  });

  it('takes the newest voucher whose own call and every earlier call are terminal', () => {
    const choice = chooseSettlement(
      0n,
      vouchers,
      [row(100n), row(200n), row(300n, false)],
      NOW,
      P,
    )!;
    expect(choice.voucher.id).toBe('v2');
    expect(choice.charge).toBe(200n);
    expect(choice.rows.map((r) => r.intentId)).toEqual(['i100', 'i200']);
  });

  it('waives refunded calls: charge = served, waived = the rest of the step', () => {
    const choice = chooseSettlement(
      0n,
      vouchers,
      [row(100n), row(200n, true, false), row(300n)],
      NOW,
      P,
    )!;
    expect(choice.voucher.id).toBe('v3');
    expect(choice.charge).toBe(200n);
    expect(choice.waived).toBe(100n);
  });

  it('never chooses a voucher not settleable at chainNow + U, nor one issued past chainNow + 60', () => {
    // expiresAt + 7200 = chainNow + U − 1: not settleable by the time it lands.
    const expiresAt = NOW + 1_800 - 7_200 - 1;
    const old = [{ id: 'v1', cumulative: 100n, calls: 1, issuedAt: expiresAt - 240, expiresAt }];
    expect(chooseSettlement(0n, old, [row(100n)], NOW, P)).toBeNull();
    const future = [
      { id: 'v1', cumulative: 100n, calls: 1, issuedAt: NOW + 61, expiresAt: NOW + 300 },
    ];
    expect(chooseSettlement(0n, future, [row(100n)], NOW, P)).toBeNull();
  });

  it('refuses to charge more than the signed step', () => {
    const wrong = [{ ...row(100n), price: 150n }];
    expect(() => chooseSettlement(0n, vouchers, wrong, NOW, P)).toThrow(/above the signed step/);
  });

  it('newest usable expiry feeds D', () => {
    expect(newestUsableExpiry(0n, vouchers, NOW)).toBe(NOW + 230);
    expect(newestUsableExpiry(300n, vouchers, NOW)).toBeNull();
  });
});

describe('channel policy — buckets (the contract rule, to plan collect-first)', () => {
  const m = (offsetHours: number) => NOW / 3_600 + offsetHours;
  const nextM = Math.ceil((NOW + 3_600) / 3_600);

  it('places a charge in the matching, then an empty bucket', () => {
    expect(placeCharge(EMPTY_SLOT, NOW, 3_600, 1_000, 10n)).toBe('B1');
    expect(
      placeCharge({ ...EMPTY_SLOT, h1: 5n, m1: nextM, r1: 1_000 }, NOW, 3_600, 1_000, 10n),
    ).toBe('B1');
    expect(
      placeCharge({ ...EMPTY_SLOT, h1: 5n, m1: m(-1), r1: 1_000 }, NOW, 3_600, 1_000, 10n),
    ).toBe('B2');
  });

  it('a matured bucket left uncollected next to a pending one blocks the fold: collect first (SPEC-W2 §3)', () => {
    // Both buckets full of other hours; the newest of this rate has MATURED.
    const slot = { ...EMPTY_SLOT, h1: 5n, m1: m(-2), r1: 1_000, h2: 5n, m2: m(0), r2: 1_000 };
    expect(placeCharge(slot, NOW, 3_600, 1_000, 10n)).toBe('NO_BUCKET');
    // Collect-first empties the matured buckets; the charge then has a bucket.
    expect(maturedAmount(slot, NOW)).toBe(10n);
    expect(placeCharge(EMPTY_SLOT, NOW, 3_600, 1_000, 10n)).toBe('B1');
  });

  it('folds into the newest pending bucket of the same rate; never across a pending other rate', () => {
    const fold = {
      ...EMPTY_SLOT,
      h1: 5n,
      m1: m(-3),
      r1: 1_000,
      h2: 5n,
      m2: m(1) - 1 + 1,
      r2: 1_000,
    };
    // m2 not matured (in the future), m1 in the past but different hour: fold into bucket 2.
    expect(placeCharge({ ...fold, m2: m(1) }, NOW + 60, 3_600, 1_000, 10n)).toBe('FOLD');
    const rates = { ...EMPTY_SLOT, h1: 5n, m1: m(2), r1: 900, h2: 5n, m2: m(1), r2: 1_000 };
    expect(placeCharge(rates, NOW + 60, 3_600, 1_000, 10n)).toBe('NO_BUCKET');
  });

  it('refunds from the newest bucket still inside its window, and names its deadline', () => {
    const slot = { ...EMPTY_SLOT, h1: 50n, m1: m(-1), r1: 1_000, h2: 50n, m2: m(1), r2: 1_000 };
    expect(refundBucket(slot, 40n, NOW)).toEqual({ maturityHour: m(1), takeRateBps: 1_000 });
    expect(refundBucket(slot, 60n, NOW)).toBeNull();
    expect(earliestRefundDeadline(slot)).toBe(m(-1) * 3_600 + 7 * 24 * 3_600);
  });
});

describe('channel policy — collect attribution (FIFO, v3 §5.2)', () => {
  const held = [
    { intentId: 'a', price: 100n, collectableAt: NOW - 100, cumulative: 100n, kept: false },
    { intentId: 'b', price: 100n, collectableAt: NOW - 100, cumulative: 200n, kept: true },
    { intentId: 'c', price: 100n, collectableAt: NOW, cumulative: 300n, kept: false },
  ];

  it('pays the oldest first and skips what a dispute keeps', () => {
    const { paid, unattributed } = attributeCollect(held, 200n);
    expect(paid.map((r) => r.intentId)).toEqual(['a', 'c']);
    expect(unattributed).toBe(0n);
  });

  it('reports what no held row accounts for', () => {
    expect(attributeCollect(held, 250n).unattributed).toBe(50n);
  });
});

describe('channel policy — payout cadence (SPEC-W2 §8)', () => {
  const MIN = 25_000_000n;
  const sixGrid = Math.floor(NOW / 21_600) * 21_600;

  it('EVERY_6_HOURS pays once per 6-hour slot', () => {
    expect(payoutDue('EVERY_6_HOURS', 1n, sixGrid - 1, NOW, MIN)).toBe(true);
    expect(payoutDue('EVERY_6_HOURS', 1n, sixGrid + 1, NOW, MIN)).toBe(false);
  });

  it('HOURLY pays on the hour only when $25 is ready, else falls back to the 6-hour slot', () => {
    const hour = Math.floor(NOW / 3_600) * 3_600;
    expect(payoutDue('HOURLY', MIN, hour - 1, NOW, MIN)).toBe(true);
    expect(payoutDue('HOURLY', MIN - 1n, Math.max(hour - 1, sixGrid), NOW, MIN)).toBe(false);
    expect(nextPayoutAt('HOURLY', MIN, NOW, MIN)).toBe(hour + 3_600);
    expect(nextPayoutAt('HOURLY', MIN - 1n, NOW, MIN)).toBe(sixGrid + 21_600);
  });

  it('nothing ready, nothing due', () => {
    expect(payoutDue('HOURLY', 0n, null, NOW, MIN)).toBe(false);
  });
});

describe('channel policy — reservation (POLICY §2.3)', () => {
  it('asks for an urgent round at 80% of available', () => {
    expect(
      reservationUrgent({ availableAtomic: 1_000n, pendingAtomic: 700n, priceAtomic: 99n }, 8_000),
    ).toBe(false);
    expect(
      reservationUrgent({ availableAtomic: 1_000n, pendingAtomic: 700n, priceAtomic: 100n }, 8_000),
    ).toBe(true);
  });
});
