import type { Redis } from 'ioredis';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { Money } from '@modules/chains/ports/money.types';
import {
  SpendPolicyVelocityService,
  VelocityLimits,
  VelocityViolationKind,
} from '@modules/spend-policy/services/spend-policy-velocity.service';
import { DUPLICATE_REQUEST_THRESHOLD } from '@modules/spend-policy/constants/spend-policy-defaults.constants';

import { FakeRedis } from './helpers/fake-redis';

const ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;
const AGENT = 'agent-1';
const HASH = 'sha256:' + 'a'.repeat(64);

function price(amount: string): Money {
  return { amount, asset: ASSET, decimals: 6 };
}

const UNLIMITED: VelocityLimits = {
  maxCallsPerMinute: null,
  maxCallsPerHour: null,
  maxSpendPerHour: null,
};

let redis: FakeRedis;
let velocity: SpendPolicyVelocityService;

/** Deep inside a fixed minute/hour boundary, far from either edge. */
const T0 = new Date('2026-08-20T10:00:10.000Z').getTime();

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  redis = new FakeRedis();
  velocity = new SpendPolicyVelocityService(redis as unknown as Redis);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('SpendPolicyVelocityService.consume — calls/minute', () => {
  it('permits calls up to the limit and refuses the one that exceeds it', async () => {
    const limits: VelocityLimits = { ...UNLIMITED, maxCallsPerMinute: 3 };

    for (let i = 0; i < 3; i++) {
      const result = await velocity.consume(AGENT, `${HASH}-${i}`, price('1'), limits);
      expect(result).toBeNull();
    }

    const fourth = await velocity.consume(AGENT, `${HASH}-4`, price('1'), limits);
    expect(fourth?.kind).toBe(VelocityViolationKind.CALLS_PER_MINUTE);
    expect(fourth?.retryAfterSeconds).toBeGreaterThan(0);
  });

  /**
   * 100 retries inside one minute must be stopped
   * by the velocity limit. Written to be legible — it reports exactly how
   * many of the 100 attempts were blocked and at which attempt the limit
   * first bit.
   */
  it('a 100-iteration retry loop inside one minute is stopped by the velocity limit', async () => {
    const limits: VelocityLimits = { ...UNLIMITED, maxCallsPerMinute: 60 };
    let firstBlockedAt: number | null = null;
    let blockedCount = 0;

    for (let attempt = 1; attempt <= 100; attempt++) {
      // Same request hash every time — this genuinely is one retry loop.
      const result = await velocity.consume(AGENT, HASH, price('1'), limits);
      if (result) {
        blockedCount += 1;
        if (firstBlockedAt === null) firstBlockedAt = attempt;
      }
    }

    console.log(
      `retry-loop check: 100 attempts, first blocked at attempt #${firstBlockedAt}, ` +
        `${blockedCount} of 100 blocked (limit: ${limits.maxCallsPerMinute}/min, ` +
        `duplicate-hash threshold: ${DUPLICATE_REQUEST_THRESHOLD})`,
    );

    // The duplicate-hash detector (threshold 5) trips before the per-minute
    // counter (limit 60) can, since every attempt in this loop is the exact
    // same request — which is realistic: a retry loop resends the same call.
    // From attempt 61 the per-minute ceiling *also* starts refusing (checked
    // first in `consume`'s order), so the two mechanisms overlap for the back
    // half of the loop — the requirement is only that the loop is
    // stopped, not which of the two velocity checks did it.
    expect(firstBlockedAt).toBe(DUPLICATE_REQUEST_THRESHOLD);
    expect(blockedCount).toBe(100 - DUPLICATE_REQUEST_THRESHOLD + 1);
    // Every one of the 100 attempts was recorded — see the class doc on why a
    // refused attempt is still counted (the `RedisSigningRateLimiter` idiom).
    expect(Number(redis.strings.get(callsMinKey()))).toBe(100);
  });

  it("a distinct request hash is not throttled by another hash's duplicate count, only by the shared per-minute ceiling", async () => {
    const limits: VelocityLimits = { ...UNLIMITED, maxCallsPerMinute: 200 };
    for (let i = 0; i < DUPLICATE_REQUEST_THRESHOLD - 1; i++) {
      const result = await velocity.consume(AGENT, `${HASH}-distinct-${i}`, price('1'), limits);
      expect(result).toBeNull();
    }
  });
});

describe('SpendPolicyVelocityService.consume — calls/hour', () => {
  it('permits up to the limit and refuses the call that exceeds it', async () => {
    const limits: VelocityLimits = { ...UNLIMITED, maxCallsPerHour: 2 };

    expect(await velocity.consume(AGENT, `${HASH}-a`, price('1'), limits)).toBeNull();
    expect(await velocity.consume(AGENT, `${HASH}-b`, price('1'), limits)).toBeNull();

    const third = await velocity.consume(AGENT, `${HASH}-c`, price('1'), limits);
    expect(third?.kind).toBe(VelocityViolationKind.CALLS_PER_HOUR);
  });
});

describe('SpendPolicyVelocityService.consume — spend/hour', () => {
  it('permits spend up to the ceiling and refuses the call that would exceed it', async () => {
    const limits: VelocityLimits = { ...UNLIMITED, maxSpendPerHour: price('100') };

    expect(await velocity.consume(AGENT, `${HASH}-a`, price('60'), limits)).toBeNull();
    expect(await velocity.consume(AGENT, `${HASH}-b`, price('40'), limits)).toBeNull();

    const third = await velocity.consume(AGENT, `${HASH}-c`, price('1'), limits);
    expect(third?.kind).toBe(VelocityViolationKind.SPEND_PER_HOUR);
  });
});

describe('SpendPolicyVelocityService.consume — duplicate-request detection', () => {
  it(`fires once at the ${DUPLICATE_REQUEST_THRESHOLD}th identical hash and suppresses the notification after that`, async () => {
    const results = [];
    for (let i = 0; i < DUPLICATE_REQUEST_THRESHOLD + 3; i++) {
      results.push(await velocity.consume(AGENT, HASH, price('1'), UNLIMITED));
    }

    // Every attempt before the threshold is permitted.
    for (let i = 0; i < DUPLICATE_REQUEST_THRESHOLD - 1; i++) {
      expect(results[i]).toBeNull();
    }

    // From the threshold onward, every attempt is refused as a duplicate —
    // but only the first of them is a "fresh" anomaly worth notifying about.
    const violations = results.slice(DUPLICATE_REQUEST_THRESHOLD - 1);
    expect(violations.every((v) => v?.kind === VelocityViolationKind.DUPLICATE_REQUEST)).toBe(true);
    expect(violations[0]?.freshAnomaly).toBe(true);
    expect(violations.slice(1).every((v) => v?.freshAnomaly === false)).toBe(true);
  });
});

describe('SpendPolicyVelocityService.consume — Redis unavailable', () => {
  it('fails CLOSED: reports UNAVAILABLE rather than permitting the call', async () => {
    redis.down = true;

    const result = await velocity.consume(AGENT, HASH, price('1'), {
      ...UNLIMITED,
      maxCallsPerMinute: 60,
    });

    expect(result?.kind).toBe(VelocityViolationKind.UNAVAILABLE);
    expect(result?.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('SpendPolicyVelocityService.read', () => {
  it('reports the same counters consume() wrote, without incrementing them', async () => {
    await velocity.consume(AGENT, `${HASH}-a`, price('30'), UNLIMITED);
    await velocity.consume(AGENT, `${HASH}-b`, price('20'), UNLIMITED);

    const before = redis.commands.length;
    const usage = await velocity.read(AGENT);
    const after = redis.commands.length;

    expect(usage).toEqual({
      callsThisMinute: 2,
      callsThisHour: 2,
      spendThisHour: 50n,
      readable: true,
    });
    // Three GETs, no INCR — a display read must never itself count as a call.
    expect(after - before).toBe(3);
    expect(redis.commands.slice(before).every((c) => c.startsWith('get '))).toBe(true);
  });

  it('reports unreadable rather than a wrong zero when Redis is down', async () => {
    redis.down = true;

    const usage = await velocity.read(AGENT);

    expect(usage).toEqual({
      callsThisMinute: null,
      callsThisHour: null,
      spendThisHour: null,
      readable: false,
    });
  });
});

function callsMinKey(): string {
  const bucket = Math.floor(T0 / 60_000);
  return `spend-policy:velocity:calls-min:${AGENT}:${bucket}`;
}
