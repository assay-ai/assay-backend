import { BindingAttemptRepository } from '@database/postgres/repositories/binding-attempt.repository';
import { BindingStatsRow } from '@database/postgres/repositories/binding-stats.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import {
  ChainEnrolment,
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
  enrolmentKey,
} from '@modules/provider/ports/chain-enrolment.port';
import { ProviderRoutingState, ProviderTier } from '@modules/provider/ports/provider.types';
import { DbProviderRegistry } from '@modules/provider/services/db-provider-registry';
import { ClassificationReason } from '@modules/tool/domain/classification/classification.types';
import {
  NEUTRAL_PRIOR,
  computeWeights,
  scoreCandidates,
  statsOf,
} from '@modules/tool/domain/routing';
import { BindingAttemptRecorder } from '@modules/tool/services/binding-attempt-recorder.service';

import { noBlocks } from '../helpers/blocklist';
import {
  PAYOUT_ACCOUNT,
  PAYOUT_CHAIN,
  ROUTING_CONTEXT,
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildCandidate,
  buildProvider,
  buildRouter,
  ok,
  seededRandom,
  status,
  usdc,
} from './helpers/routing-fixtures';

/**
 * The router on observed stats (backlog G1.1).
 *
 * Before the pipeline every provider scored `NEUTRAL_PRIOR` on quality,
 * availability and latency, so a broken provider kept its share until it was
 * slashed. These tests take the real path — `binding_stats` rows through
 * `DbProviderRegistry` into the router — and show the share move.
 */
describe('routing on observed stats', () => {
  const A = 'provider-a';
  const B = 'provider-b';
  const stakes = { [A]: usdc(1000), [B]: usdc(1000) };

  function window(bindingId: string, providerId: string, available: number): BindingStatsRow {
    return {
      bindingId,
      providerId,
      attempts: 1000,
      availableAttempts: available,
      latencySamples: 0,
      p50LatencyMs: null,
      p95LatencyMs: null,
      verdicts: 0,
      passedVerdicts: 0,
    };
  }

  /** The production registry, over stubbed tables. */
  async function statesFrom(rows: readonly BindingStatsRow[] | null) {
    const providers = {
      find: async () =>
        [A, B].map((organizationId) => ({
          organizationId,
          status: 'ACTIVE',
          tier: ProviderTier.ESTABLISHED,
        })),
    } as unknown as ProviderRepository;
    const enrolments: ChainEnrolmentPort = {
      enrolmentsOf: async (ids) =>
        new Map(
          ids.map((providerId) => [
            enrolmentKey(providerId, PAYOUT_CHAIN),
            {
              providerId,
              chainId: PAYOUT_CHAIN,
              payoutAccountId: PAYOUT_ACCOUNT,
              stakeAuthorityAccountId: null,
              status: ChainEnrolmentStatus.ACTIVE,
              enrolledAt: new Date('2026-10-01T00:00:00Z'),
            } as ChainEnrolment,
          ]),
        ),
    };
    const registry = new DbProviderRegistry(
      providers,
      enrolments,
      noBlocks(),
      null,
      rows ? ({ findByProviders: async () => rows } as never) : null,
    );
    return [...(await registry.findRoutingStates([A, B])).values()];
  }

  async function sharesOver(states: ProviderRoutingState[], calls = 3_000) {
    const invoker = new ScriptedInvoker({
      [`binding-${A}`]: async () => ok(),
      [`binding-${B}`]: async () => ok(),
    });
    const { router } = buildRouter({
      bindings: [buildBinding(A), buildBinding(B)],
      providers: states,
      stakes,
      invoker,
      random: seededRandom(7),
    });
    for (let call = 0; call < calls; call += 1) {
      await router.route({
        toolId: TOOL_ID,
        callId: 'test-call-id',
        input: { query: 'x' },
        context: ROUTING_CONTEXT,
      });
    }
    const share = (id: string) => invoker.providerIds.filter((p) => p === id).length / calls;
    return { a: share(A), b: share(B) };
  }

  it('gives a provider with poor availability a lower share of the traffic', async () => {
    // Without observations the two are indistinguishable: an even split.
    const before = await sharesOver(await statesFrom(null));
    expect(before.b).toBeGreaterThan(0.46);
    expect(before.b).toBeLessThan(0.54);

    // B now fails four attempts in five. Scores: A 0.6975, B 0.5 — so B's
    // share falls to about 0.42 of the tool.
    const after = await sharesOver(
      await statesFrom([window(`binding-${A}`, A, 990), window(`binding-${B}`, B, 200)]),
    );
    expect(after.b).toBeLessThan(0.45);
    expect(after.a).toBeGreaterThan(0.55);
    expect(after.b).toBeLessThan(before.b - 0.05);
  });

  it('keeps the even split when the windows are below the minimum sample', async () => {
    const thin = (id: string, providerId: string, available: number) => ({
      ...window(id, providerId, available),
      attempts: 49,
    });
    const states = await statesFrom([thin(`binding-${A}`, A, 49), thin(`binding-${B}`, B, 0)]);
    const shares = await sharesOver(states, 2_000);
    expect(shares.b).toBeGreaterThan(0.45);
    expect(shares.b).toBeLessThan(0.55);
  });

  it('scores each binding of one provider on its own window', () => {
    const provider = {
      stats: { availabilityRate: 0.55 },
      bindingStats: new Map([
        ['a-healthy', { availabilityRate: 1 }],
        ['a-broken', { availabilityRate: 0.1 }],
      ]),
    };
    const weights = computeWeights(
      scoreCandidates([
        buildCandidate(A, { binding: { id: 'a-healthy' }, provider }),
        buildCandidate(A, { binding: { id: 'a-broken' }, provider }),
        buildCandidate(B, { provider: { stats: {} } }),
      ]),
    );
    const weightOf = (id: string) => weights.find((w) => w.candidate.binding.id === id)!.weight;

    expect(weightOf('a-broken')).toBeLessThan(weightOf('a-healthy'));
  });

  it('falls back to the provider’s pooled figure field by field, then to the neutral prior', () => {
    const candidate = buildCandidate(A, {
      binding: { id: 'a-1' },
      provider: {
        stats: { availabilityRate: 0.8, paidQualityRate: 0.7 },
        bindingStats: new Map([['a-1', { availabilityRate: 0.95 }]]),
      },
    });
    expect(statsOf(candidate)).toEqual({ availabilityRate: 0.95, paidQualityRate: 0.7 });

    const [scored] = scoreCandidates([candidate]);
    expect(scored.components.availability).toBe(0.95);
    expect(scored.components.quality).toBe(0.7);
    expect(scored.components.latency).toBe(NEUTRAL_PRIOR);
  });

  it('publishes the binding’s own measured p95 on the quote', async () => {
    const { router } = buildRouter({
      bindings: [buildBinding(A)],
      providers: [
        buildProvider(A, {
          stats: {},
          bindingStats: new Map([[`binding-${A}`, { p95LatencyMs: 1_234 }]]),
        }),
      ],
      stakes,
      invoker: new ScriptedInvoker({}),
    });
    const quote = await router.quote(TOOL_ID, ROUTING_CONTEXT);
    expect(quote?.p95LatencyMs).toBe(1_234);
  });

  describe('recording attempts', () => {
    async function routeWith(buyerOrganizationId: string) {
      const append = jest.fn(async () => undefined);
      const invoker = new ScriptedInvoker({
        [`binding-${A}`]: async () => status(503, { error: 'overloaded' }),
        [`binding-${B}`]: async () => ok(),
      });
      const { router } = buildRouter({
        bindings: [buildBinding(A), buildBinding(B)],
        providers: [buildProvider(A), buildProvider(B)],
        stakes,
        invoker,
        observations: new BindingAttemptRecorder({ append } as unknown as BindingAttemptRepository),
      });
      await router.route({
        toolId: TOOL_ID,
        callId: 'test-call-id',
        input: { query: 'x' },
        context: { ...ROUTING_CONTEXT, callClass: 'PAID', buyerOrganizationId },
      });
      // The write is off the caller's path; let it land.
      await new Promise((resolve) => setImmediate(resolve));
      return append;
    }

    it('records every attempt, the failed-over one included', async () => {
      const append = await routeWith('org-buyer');

      expect(append).toHaveBeenCalledTimes(2);
      expect(append).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          bindingId: `binding-${A}`,
          providerId: A,
          available: false,
          latencyMs: null,
          callClass: 'PAID',
          reason: ClassificationReason.UPSTREAM_SERVER_ERROR,
        }),
      );
      expect(append).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          bindingId: `binding-${B}`,
          providerId: B,
          available: true,
          latencyMs: expect.any(Number),
          reason: ClassificationReason.OK,
        }),
      );
    });

    it('leaves out the attempt a provider served to its own organization', async () => {
      const append = await routeWith(B);

      expect(append).toHaveBeenCalledTimes(1);
      expect(append).toHaveBeenCalledWith(expect.objectContaining({ providerId: A }));
    });
  });
});
