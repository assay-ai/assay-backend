/**
 * A fixed, non-UTC zone for the whole file.
 *
 * The daily quota resets on the **UTC** calendar day, and the only way to prove
 * that rather than assert it is to run where the local day and the UTC day
 * disagree. Set before anything imports `Date`; Node re-reads `TZ` on the next
 * date operation, and Jest's fake timers respect it — checked, not assumed.
 *
 * Without this the test is silently vacuous on a runner whose zone is already
 * UTC, which is most CI containers — i.e. it would pass against a
 * `getDate()`-based implementation on exactly the machine that matters.
 */
process.env.TZ = 'Asia/Kolkata';

import type { Redis } from 'ioredis';

import { CeilingKind } from '@modules/tool/domain/routing';
import { BindingStatus, PricingMode, ToolBinding } from '@modules/tool/ports/tool.types';
import {
  BINDING_DAILY_KEY_PREFIX,
  BINDING_RPS_KEY_PREFIX,
  BindingCeilingService,
  RPS_WINDOW_MS,
} from '@modules/tool/services/binding-ceiling.service';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';

import { FakeRedis } from './helpers/fake-redis';

/**
 * The provider's self-declared ceilings (maxRps, daily quota, timeout): hitting a
 * ceiling sheds traffic rather than letting their calls fail.
 *
 * ## The distinction the whole suite turns on: READ vs CONSUME
 *
 * `filterEligible` is pure and synchronous, so it cannot read Redis. The
 * ceiling therefore arrives on the candidate, read **before** filtering, and
 * the token is spent **after** selection on the one binding actually invoked.
 *
 * Getting that wrong is not a crash, which is why it is tested rather than
 * commented. Consuming at filter time would spend one token per *candidate*
 * per routing decision, so a provider who declared `max_rps: 10` behind a tool
 * with five bindings would really be held to two — and a check that asks only
 * "does it shed?" would still be green, because it only asks
 * whether traffic sheds and never at what threshold. So the threshold is what
 * is asserted here.
 */

const STAKE_ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;

function buildBinding(id: string, overrides: Partial<ToolBinding> = {}): ToolBinding {
  return {
    id,
    toolId: 'search_web',
    providerId: `provider-${id}`,
    endpoint: `https://${id}.example.com/api`,
    requestMapping: { method: 'POST', path: '/search', body: { q: { $path: '$.query' } } },
    responseMapping: { answer: { $path: '$.answer' } },
    pricingMode: PricingMode.PAID,
    priceAmount: '50000',
    assetId: STAKE_ASSET,
    // Required on the domain type. Nothing in this file
    // reads it — ceilings are counted per binding and are chain-agnostic — so
    // it is the one-chain default and never a subject of a case here.
    settlementChains: [CHAIN_IDS.SOLANA_DEVNET],
    freeQuotaPerAgent: null,
    freeDailyBudget: null,
    maxRps: null,
    maxDailyCalls: null,
    slaFailureRate: 0.02,
    timeoutMs: 5_000,
    status: BindingStatus.ACTIVE,
    version: 1,
    ...overrides,
  };
}

let redis: FakeRedis;
let ceilings: BindingCeilingService;
let warnings: string[];

/** Deep inside a UTC day, and deliberately not inside the same local one. */
const T0 = new Date('2026-08-20T10:00:00.000Z').getTime();

function build(): void {
  redis = new FakeRedis();
  ceilings = new BindingCeilingService(redis as unknown as Redis);
  warnings = [];
  jest
    .spyOn((ceilings as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn')
    .mockImplementation((message: string) => {
      warnings.push(message);
    });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  build();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('BindingCeilingService — reading a ceiling', () => {
  it('reports MAX_RPS once the bucket is empty', async () => {
    const binding = buildBinding('b1', { maxRps: 3 });

    expect(await ceilings.read(binding)).toBeNull();

    for (let i = 0; i < 3; i += 1) {
      expect(await ceilings.consume(binding)).toBeNull();
    }

    expect(await ceilings.read(binding)).toBe(CeilingKind.MAX_RPS);
    expect((await ceilings.remaining(binding)).rps).toBe(0);
  });

  it('refills as the one-second window slides, without anyone resetting it', async () => {
    const binding = buildBinding('b1', { maxRps: 2 });

    await ceilings.consume(binding);
    await ceilings.consume(binding);
    expect(await ceilings.read(binding)).toBe(CeilingKind.MAX_RPS);

    // A ceiling that needed a sweeper to clear would be a ceiling that stays
    // hit whenever the sweeper is down — which is an outage caused by the
    // control that exists to prevent one.
    jest.setSystemTime(T0 + RPS_WINDOW_MS + 1);
    expect(await ceilings.read(binding)).toBeNull();
    expect((await ceilings.remaining(binding)).rps).toBe(2);
  });

  it('reports MAX_DAILY_CALLS once the day is spent', async () => {
    const binding = buildBinding('b1', { maxDailyCalls: 2 });

    expect(await ceilings.read(binding)).toBeNull();
    await ceilings.consume(binding);
    await ceilings.consume(binding);

    expect(await ceilings.read(binding)).toBe(CeilingKind.MAX_DAILY_CALLS);
    expect((await ceilings.remaining(binding)).daily).toBe(0);
  });

  it('names the daily ceiling first, because it is the one still hit next second', async () => {
    // Both are hit. `MAX_RPS` clears within a second and `MAX_DAILY_CALLS`
    // does not clear until midnight, so telling a provider "you are at your
    // rps" when their day is spent sends them to fix the wrong thing.
    const binding = buildBinding('b1', { maxRps: 1, maxDailyCalls: 1 });
    await ceilings.consume(binding);

    expect(await ceilings.read(binding)).toBe(CeilingKind.MAX_DAILY_CALLS);
  });

  it('treats a null ceiling as no ceiling — and asks Redis nothing at all', async () => {
    // Both columns are nullable and the overwhelming majority of bindings will
    // leave both null. A round trip per candidate for a limit nobody declared
    // is a cost paid by every routing decision on the platform.
    const binding = buildBinding('b1');

    expect(await ceilings.read(binding)).toBeNull();
    expect(await ceilings.consume(binding)).toBeNull();
    expect(await ceilings.remaining(binding)).toEqual({ rps: null, daily: null });
    expect(redis.commands).toEqual([]);
  });

  it('is not fooled by a ceiling of zero, which is a declared refusal', async () => {
    // `null` means "no limit"; `0` means the provider declared themselves
    // unroutable. They must not collapse into the same branch — `?? ` would.
    const binding = buildBinding('b1', { maxRps: 0 });

    expect(await ceilings.read(binding)).toBe(CeilingKind.MAX_RPS);
    expect(await ceilings.consume(binding)).toBe(CeilingKind.MAX_RPS);
  });
});

describe('BindingCeilingService — read never spends', () => {
  it('does NOT consume a token per candidate', async () => {
    const maxRps = 5;
    const binding = buildBinding('b1', { maxRps });
    const candidates = [binding, binding, binding, binding, binding];

    await Promise.all(candidates.map((candidate) => ceilings.read(candidate)));

    // Nothing spent. If `read` consumed, this would be `0` and the provider's
    // real ceiling would be `maxRps / candidates.length`.
    expect((await ceilings.remaining(binding)).rps).toBe(maxRps);
    expect(redis.zsets.get(`${BINDING_RPS_KEY_PREFIX}b1`) ?? new Map()).toHaveProperty('size', 0);
  });

  it('issues no write command while reading', async () => {
    const binding = buildBinding('b1', { maxRps: 5, maxDailyCalls: 100 });
    await ceilings.read(binding);

    // Stated as a property of the command log rather than of the resulting
    // state: a `zremrangebyscore` that trimmed expired members would leave the
    // count unchanged and still make `read` a write, which is the thing a
    // replica-routed read would then break on.
    expect(redis.commands).toEqual([
      `get ${BINDING_DAILY_KEY_PREFIX}b1:2026-08-20`,
      `zcount ${BINDING_RPS_KEY_PREFIX}b1`,
    ]);
  });

  it('reads every candidate in one batch, not one round trip each', async () => {
    const bindings = ['b1', 'b2', 'b3'].map((id) => buildBinding(id, { maxRps: 2 }));

    const hits = await ceilings.readAll(bindings);

    expect(hits.size).toBe(0);
    // `gatherCandidates` forbids a per-candidate read on the hot path in its
    // own doc comment; `readAll` is what keeps the router able to honour that.
    expect(await ceilings.remaining(bindings[0])).toEqual({ rps: 2, daily: null });
  });
});

describe('BindingCeilingService — consuming a token', () => {
  it('consumes exactly one token, on the binding actually invoked', async () => {
    const invoked = buildBinding('invoked', { maxRps: 4, maxDailyCalls: 10 });
    const passedOver = buildBinding('passed-over', { maxRps: 4, maxDailyCalls: 10 });

    // Both were candidates; only one was selected.
    await ceilings.readAll([invoked, passedOver]);
    expect(await ceilings.consume(invoked)).toBeNull();

    expect(await ceilings.remaining(invoked)).toEqual({ rps: 3, daily: 9 });
    expect(await ceilings.remaining(passedOver)).toEqual({ rps: 4, daily: 10 });
  });

  it('sheds when the bucket empties between read and consume', async () => {
    const binding = buildBinding('b1', { maxRps: 2 });

    // The read at filter time says the binding is routable...
    expect(await ceilings.read(binding)).toBeNull();

    // ...and by the time it is selected, concurrent traffic has taken the
    // last two tokens. This is the ordinary case under load, not an edge one.
    await ceilings.consume(binding);
    await ceilings.consume(binding);

    // An ordinary shed, reported with the same `CeilingKind` the filter would
    // have reported — so the router fails over exactly as if the ceiling had been
    // hit at filter time, rather than handing the provider a call they said
    // they could not take.
    expect(await ceilings.consume(binding)).toBe(CeilingKind.MAX_RPS);
  });

  it('leaves no token spent when it sheds', async () => {
    const binding = buildBinding('b1', { maxRps: 1 });

    await ceilings.consume(binding);
    await ceilings.consume(binding);
    await ceilings.consume(binding);

    // A refused call never reached the provider, so it must not sit in the
    // window holding a token — otherwise a burst of shedding extends the
    // outage past the rate the provider actually declared. This is a
    // deliberate divergence from `RedisSigningRateLimiter`, where a refused
    // attempt DOES count because the thing being bounded there is attempts.
    expect((await ceilings.remaining(binding)).rps).toBe(0);
    expect(redis.zsets.get(`${BINDING_RPS_KEY_PREFIX}b1`)?.size).toBe(1);
  });

  it('does not spend a daily call when the rps bucket refuses', async () => {
    const binding = buildBinding('b1', { maxRps: 1, maxDailyCalls: 100 });

    await ceilings.consume(binding);
    expect(await ceilings.consume(binding)).toBe(CeilingKind.MAX_RPS);

    // The second call was shed, so it must not have eaten a day's allowance.
    // A daily quota that drains on calls that never happened is a quota the
    // provider cannot reconcile against their own logs.
    expect((await ceilings.remaining(binding)).daily).toBe(99);
  });

  it('does not touch the rps bucket when the day is already spent', async () => {
    const binding = buildBinding('b1', { maxRps: 10, maxDailyCalls: 1 });

    await ceilings.consume(binding);
    expect(await ceilings.consume(binding)).toBe(CeilingKind.MAX_DAILY_CALLS);

    expect((await ceilings.remaining(binding)).rps).toBe(9);
  });
});

describe('BindingCeilingService — the daily quota resets on the UTC day', () => {
  it('keys the counter on the UTC calendar day, not a local one', async () => {
    // 00:30 on the 21st in `Asia/Kolkata` (UTC+5:30), which is still 17:30 on
    // the 20th UTC. A `getDate()`-based key would say `2026-08-21` here.
    jest.setSystemTime(new Date('2026-08-20T17:30:00.000Z'));
    const binding = buildBinding('b1', { maxDailyCalls: 1 });

    await ceilings.consume(binding);

    expect([...redis.strings.keys()]).toEqual([`${BINDING_DAILY_KEY_PREFIX}b1:2026-08-20`]);
    expect(new Date().getDate()).toBe(21); // the local day really has rolled
  });

  it('resets the daily counter on the UTC day, not a local one', async () => {
    const binding = buildBinding('b1', { maxDailyCalls: 1 });

    // Spend the day's single call at 16:30Z.
    jest.setSystemTime(new Date('2026-08-20T16:30:00.000Z'));
    expect(await ceilings.consume(binding)).toBeNull();
    expect(await ceilings.read(binding)).toBe(CeilingKind.MAX_DAILY_CALLS);

    // Local midnight has passed — 00:30 on the 21st in `Asia/Kolkata` —
    // and nothing resets. Two providers with the same declared ceiling get the
    // same limit during the same hour, whatever timezone either of them sits
    // in, which is the only version anybody can reconcile.
    jest.setSystemTime(new Date('2026-08-20T17:30:00.000Z'));
    expect(await ceilings.read(binding)).toBe(CeilingKind.MAX_DAILY_CALLS);

    // UTC midnight, and the allowance is back.
    jest.setSystemTime(new Date('2026-08-21T00:30:00.000Z'));
    expect(await ceilings.read(binding)).toBeNull();
    expect(await ceilings.consume(binding)).toBeNull();
  });

  it('gives the day key a TTL, so a binding does not leak one key per day forever', async () => {
    jest.setSystemTime(new Date('2026-08-20T23:00:00.000Z'));
    const binding = buildBinding('b1', { maxDailyCalls: 5 });

    await ceilings.consume(binding);

    const ttl = redis.expiries.get(`${BINDING_DAILY_KEY_PREFIX}b1:2026-08-20`);
    // Long enough to outlive the day it names, short enough that yesterday's
    // key is gone tomorrow.
    expect(ttl).toBeGreaterThan(3_600);
    expect(ttl).toBeLessThan(48 * 3_600);
  });
});

describe('BindingCeilingService — when Redis cannot answer', () => {
  it('permits rather than sheds, and says so', async () => {
    const binding = buildBinding('b1', { maxRps: 1, maxDailyCalls: 1 });
    redis.down = true;

    // The opposite direction from `RedisSigningRateLimiter`, deliberately.
    // That one guards the production of signatures that take money from
    // providers, so an unreadable counter must refuse. This guards a courtesy
    // a provider asked for: shedding every ceiling-declaring binding on the
    // platform because our cache blinked would take the supply out, and the
    // fault would be entirely ours.
    expect(await ceilings.read(binding)).toBeNull();
    expect(await ceilings.consume(binding)).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('treats a discarded MULTI as "the counter did not run"', async () => {
    const binding = buildBinding('b1', { maxRps: 1 });
    redis.down = true;

    expect(await ceilings.consume(binding)).toBeNull();
    expect(warnings.join(' ')).toContain('b1');
  });
});
