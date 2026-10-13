import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId, CHAIN_IDS, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
import {
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '@modules/provider/ports/provider-stake.port';
import { PlatformHealthService } from '@modules/operator/services/platform-health.service';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  fakeMetricsRepository,
  fakeProviderRepository,
  fakeSlashProposalRepository,
  fakeStakeSource,
  FakeMetricsOverrides,
} from './helpers/fake-metrics';

const USDC = ASSET_IDS.USDC_SOLANA_DEVNET as AssetId;

function usdc(amount: string) {
  return MoneyUtil.of(amount, USDC, 6);
}

const OBSERVED_AT = new Date('2026-08-20T10:00:00.000Z');

/** The chain the tile asks about — `ENABLED_CHAINS`, faked as this one. */
const CHAIN = chainIdOf(USDC);

function stakeRow(providerId: string, amount: string): ProviderStake {
  return { providerId, chainId: CHAIN, staked: usdc(amount), observedAt: OBSERVED_AT };
}

/** The readings map, keyed the way `ProviderStakePort` keys it. */
function stakeReadings(entries: readonly [string, string][]): ReadonlyMap<string, ProviderStake> {
  return new Map(
    entries.map(([providerId, amount]) => [
      stakeKey(providerId, CHAIN),
      stakeRow(providerId, amount),
    ]),
  );
}

function build(
  options: {
    metrics?: FakeMetricsOverrides;
    falsePositive?: { resolved: number; falsePositives: number };
    providerIds?: readonly string[];
    stakes?: ReadonlyMap<string, ProviderStake>;
    chainThrows?: boolean;
    /** `ENABLED_CHAINS`, as the tile sees it. Defaults to the one chain. */
    enabled?: readonly ChainId[];
  } = {},
): PlatformHealthService {
  return harness(options).service;
}

/** The same wiring, with the stake port handed back so a case can assert what it was asked. */
function harness(
  options: {
    metrics?: FakeMetricsOverrides;
    falsePositive?: { resolved: number; falsePositives: number };
    providerIds?: readonly string[];
    stakes?: ReadonlyMap<string, ProviderStake>;
    chainThrows?: boolean;
    enabled?: readonly ChainId[];
    chainStates?: readonly Record<string, unknown>[];
    blocked?: readonly { chainId: string; address: string }[];
  } = {},
): { service: PlatformHealthService; stakes: ProviderStakePort } {
  const stakes = fakeStakeSource({ stakes: options.stakes, throws: options.chainThrows });
  return {
    stakes,
    service: new PlatformHealthService(
      fakeMetricsRepository(options.metrics),
      fakeSlashProposalRepository(options.falsePositive),
      fakeProviderRepository(options.providerIds ?? []),
      stakes,
      options.enabled ?? [CHAIN],
      {
        findAllStates: async () => options.chainStates ?? [],
        findBlocked: async () => options.blocked ?? [],
      } as never,
    ),
  };
}

describe('PlatformHealthService', () => {
  it('returns zeros and nulls, never NaN, against an empty database', async () => {
    const service = build();

    const health = await service.getHealth();

    expect(health.intentsPerMinute).toBe(0);
    expect(health.intentsPerMinuteDeltaVsHour).toBeNull();
    expect(health.verificationBacklog).toBe(0);
    expect(health.verificationBacklogP95AgeSeconds).toBeNull();
    expect(health.falsePositiveRate).toBe(0);
    expect(Number.isNaN(health.falsePositiveRate)).toBe(false);
    expect(health.falsePositiveGate).toBe(0.02);
    expect(health.policiesInShadow).toBe(0);
    expect(health.policiesTotal).toBe(0);
    expect(health.stakeLocked.amount).toBe('0');
    expect(health.providersWithStake).toBe(0);
    expect(health.openDisputes).toBe(0);
    expect(health.oldestOpenDisputeAgeSeconds).toBeNull();
  });

  it('reports a false-positive rate of 0, not NaN, when nothing has resolved yet', async () => {
    const service = build({ falsePositive: { resolved: 0, falsePositives: 0 } });

    const health = await service.getHealth();

    expect(health.falsePositiveRate).toBe(0);
    expect(Number.isNaN(health.falsePositiveRate)).toBe(false);
  });

  it('divides false positives over resolved cases when the trailing window has data', async () => {
    const service = build({ falsePositive: { resolved: 40, falsePositives: 2 } });

    const health = await service.getHealth();

    expect(health.falsePositiveRate).toBeCloseTo(0.05);
  });

  it('computes the delta against the same minute an hour ago as a share', async () => {
    const service = build({ metrics: { intentRateCounts: { lastMinute: 15, hourAgoMinute: 10 } } });

    const health = await service.getHealth();

    expect(health.intentsPerMinute).toBe(15);
    expect(health.intentsPerMinuteDeltaVsHour).toBeCloseTo(0.5);
  });

  it('reports the delta as null on a cold start — an hour-ago figure of zero', async () => {
    const service = build({ metrics: { intentRateCounts: { lastMinute: 3, hourAgoMinute: 0 } } });

    const health = await service.getHealth();

    expect(health.intentsPerMinuteDeltaVsHour).toBeNull();
  });

  it('sums bonded stake across providers and counts only the ones with a non-zero balance', async () => {
    const service = build({
      providerIds: ['provider-a', 'provider-b', 'provider-c'],
      stakes: new Map([
        [stakeKey('provider-a', CHAIN), stakeRow('provider-a', '50000000')],
        [stakeKey('provider-b', CHAIN), stakeRow('provider-b', '25000000')],
        // provider-c is absent from the map entirely (no known stake) and
        // provider-b's own reading could just as easily have been zero —
        // both must not count toward `providersWithStake`.
      ]),
    });

    const health = await service.getHealth();

    expect(health.stakeLocked.amount).toBe('75000000');
    expect(health.stakeLocked.asset).toBe(USDC);
    expect(health.providersWithStake).toBe(2);
  });

  it('excludes a provider whose reading is a known zero from providersWithStake', async () => {
    const service = build({
      providerIds: ['provider-a'],
      stakes: stakeReadings([['provider-a', '0']]),
    });

    const health = await service.getHealth();

    expect(health.stakeLocked.amount).toBe('0');
    expect(health.providersWithStake).toBe(0);
  });

  it('degrades stakeLocked to zero instead of throwing when the stake source is unavailable', async () => {
    const service = build({ providerIds: ['provider-a'], chainThrows: true });

    // The whole point of the test: the health tile must resolve, not reject.
    await expect(service.getHealth()).resolves.toBeDefined();

    const health = await service.getHealth();
    expect(health.stakeLocked.amount).toBe('0');
    expect(health.providersWithStake).toBe(0);
  });

  it('passes the backlog p95 and dispute age straight through, including nulls', async () => {
    const service = build({
      metrics: {
        verificationBacklog: { count: 4, p95AgeSeconds: 12.5 },
        openSlashProposalCounts: { count: 2, oldestAgeSeconds: 3600 },
      },
    });

    const health = await service.getHealth();

    expect(health.verificationBacklog).toBe(4);
    expect(health.verificationBacklogP95AgeSeconds).toBe(12.5);
    expect(health.openDisputes).toBe(2);
    expect(health.oldestOpenDisputeAgeSeconds).toBe(3600);
  });
});

/**
 * Which chains the "stake locked" tile asks about.
 *
 * The tile is a platform TOTAL, so it has to ask about every chain the
 * deployment offers — a tile that asked about `enabled[0]` would under-report
 * the platform's own collateral by however much sits on the other chains, and
 * would do it silently, because an under-reported total looks exactly like a
 * smaller platform.
 *
 * `fakeStakeSource` answers only the pairs it is asked for, so both halves of
 * this are observable: the argument, and the figure that follows from it.
 */
describe('PlatformHealthService — stakeLocked spans every enabled chain', () => {
  const OTHER = CHAIN_IDS.SOLANA_MAINNET;

  it('asks about the cross product of providers and ENABLED_CHAINS', async () => {
    const { service, stakes } = harness({
      providerIds: ['provider-a', 'provider-b'],
      enabled: [CHAIN, OTHER],
    });

    await service.getHealth();

    expect(stakes.stakeOn).toHaveBeenCalledWith(
      expect.arrayContaining([
        { providerId: 'provider-a', chainId: CHAIN },
        { providerId: 'provider-a', chainId: OTHER },
        { providerId: 'provider-b', chainId: CHAIN },
        { providerId: 'provider-b', chainId: OTHER },
      ]),
    );
    expect((stakes.stakeOn as jest.Mock).mock.calls[0][0]).toHaveLength(4);
  });

  it('totals a provider bonded on two chains, and counts them once', async () => {
    // The figure that follows. A tile asking about `enabled[0]` reports
    // 50000000 here and calls it the platform's stake; the true total is 70.
    // `providersWithStake` stays 1 because it counts PROVIDERS, not readings.
    const { service } = harness({
      providerIds: ['provider-a'],
      enabled: [CHAIN, OTHER],
      stakes: new Map([
        [stakeKey('provider-a', CHAIN), stakeRow('provider-a', '50000000')],
        [stakeKey('provider-a', OTHER), { ...stakeRow('provider-a', '20000000'), chainId: OTHER }],
      ]),
    });

    const health = await service.getHealth();

    expect(health.stakeLocked.amount).toBe('70000000');
    expect(health.providersWithStake).toBe(1);
  });
});

describe('PlatformHealthService — the EVM chain-state cache', () => {
  it('reports each chain with its lag, and flags it stale past five minutes', async () => {
    const now = Date.now();
    const { service } = harness({
      chainStates: [
        {
          chainId: 'eip155:46630',
          paused: true,
          upgraded: true,
          arbiter: '0x5555555555555555555555555555555555555555',
          slashDelaySeconds: 600,
          cursorBlock: '100',
          headBlock: '100',
          caughtUpAt: new Date(now - 10_000),
          reconciledAt: new Date(now - 20_000),
        },
        {
          chainId: 'eip155:4663',
          paused: false,
          upgraded: false,
          arbiter: null,
          slashDelaySeconds: 259_200,
          cursorBlock: '5',
          headBlock: '900',
          caughtUpAt: new Date(now - 6 * 60_000),
          reconciledAt: null,
        },
      ],
      blocked: [{ chainId: 'eip155:46630', address: '0x1111111111111111111111111111111111111111' }],
    });

    const { chainState } = await service.getHealth();
    expect(chainState).toEqual([
      expect.objectContaining({
        chainId: 'eip155:46630',
        paused: true,
        blockedCount: 1,
        stale: false,
      }),
      expect.objectContaining({
        chainId: 'eip155:4663',
        upgraded: false,
        blockedCount: 0,
        stale: true,
      }),
    ]);
    expect(chainState[0].lagSeconds).toBeLessThan(60);
  });
});
