import { PlatformMetricsRepository } from '@database/postgres/repositories/platform-metrics.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import {
  ProviderChainStakeKey,
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '@modules/provider/ports/provider-stake.port';

/**
 * Hand-written fakes for {@link PlatformHealthService}'s dependencies, in the
 * style of `test/unit/provider/stake-monitor.service.spec.ts`: plain objects
 * with `jest.fn()` methods, cast to the concrete class rather than run
 * through a NestJS `TestingModule`. Named distinctly from any file another
 * agent's `test/unit/operator/helpers/` might add.
 */

export interface FakeMetricsOverrides {
  intentRateCounts?: { lastMinute: number; hourAgoMinute: number };
  verificationBacklog?: { count: number; p95AgeSeconds: number | null };
  policyLifecycleCounts?: { shadow: number; total: number };
  operatorWorkCounts?: { pendingToolReviews: number; openCallDisputes: number };
}

/** Every method defaults to the "empty database" answer. */
export function fakeMetricsRepository(
  overrides: FakeMetricsOverrides = {},
): PlatformMetricsRepository {
  return {
    intentRateCounts: jest
      .fn()
      .mockResolvedValue(overrides.intentRateCounts ?? { lastMinute: 0, hourAgoMinute: 0 }),
    verificationBacklog: jest
      .fn()
      .mockResolvedValue(overrides.verificationBacklog ?? { count: 0, p95AgeSeconds: null }),
    policyLifecycleCounts: jest
      .fn()
      .mockResolvedValue(overrides.policyLifecycleCounts ?? { shadow: 0, total: 0 }),
    operatorWorkCounts: jest
      .fn()
      .mockResolvedValue(
        overrides.operatorWorkCounts ?? { pendingToolReviews: 0, openCallDisputes: 0 },
      ),
  } as unknown as PlatformMetricsRepository;
}

export function fakeSlashProposalRepository(
  counts: { resolved: number; falsePositives: number } = { resolved: 0, falsePositives: 0 },
): SlashProposalRepository {
  return {
    falsePositiveCounts: jest.fn().mockResolvedValue(counts),
  } as unknown as SlashProposalRepository;
}

export function fakeProviderRepository(providerIds: readonly string[] = []): ProviderRepository {
  return {
    findAllProviders: jest
      .fn()
      .mockResolvedValue(providerIds.map((organizationId) => ({ organizationId }))),
  } as unknown as ProviderRepository;
}

/**
 * A `ProviderStakePort` that answers only the `(provider, chain)` pairs it was
 * actually asked for.
 *
 * The filtering is the point. A fake that returned its whole table
 * regardless of the keys makes "the tile asks about every enabled chain"
 * unobservable: a service asking about one chain, or about the wrong one, gets
 * the same answer as one asking correctly. Filtering means a wrong question
 * produces a wrong figure, which a test can see.
 */
export function fakeStakeSource(
  options: {
    /** Keyed `stakeKey(providerId, chainId)`. */
    stakes?: ReadonlyMap<string, ProviderStake>;
    throws?: boolean;
  } = {},
): ProviderStakePort {
  if (options.throws) {
    return { stakeOn: jest.fn().mockRejectedValue(new Error('rpc unreachable')) };
  }

  const table = options.stakes ?? new Map<string, ProviderStake>();
  return {
    stakeOn: jest.fn(async (keys: readonly ProviderChainStakeKey[]) => {
      const found = new Map<string, ProviderStake>();
      for (const { providerId, chainId } of keys) {
        const reading = table.get(stakeKey(providerId, chainId));
        if (reading) found.set(stakeKey(providerId, chainId), reading);
      }
      return found;
    }),
  };
}
