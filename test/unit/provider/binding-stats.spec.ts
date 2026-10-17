import { ConfigService } from '@nestjs/config';

import {
  DEFAULT_BINDING_STATS_MIN_SAMPLE,
  DEFAULT_BINDING_STATS_WINDOW_SIZE,
  loadBindingStatsConfig,
} from '@modules/provider/constants/binding-stats.constants';
import {
  BindingWindow,
  deriveBindingStats,
  mergeWindows,
  poolProviderStats,
} from '@modules/provider/domain/stats/binding-stats';

/**
 * The observed-stats arithmetic (backlog G1.1): counts in `binding_stats` →
 * the `ProviderStats` the router scores on.
 *
 * The property everything here defends is that "not enough evidence" stays
 * ABSENT. A field below the minimum sample must not appear as `0` (measured,
 * and terrible) or as a rate from three calls; it must be missing, so
 * `score.ts` keeps scoring it `NEUTRAL_PRIOR` exactly as before the pipeline
 * existed.
 */
describe('binding stats', () => {
  function window(overrides: Partial<BindingWindow> = {}): BindingWindow {
    return {
      bindingId: 'binding-a',
      providerId: 'org-a',
      attempts: 100,
      availableAttempts: 90,
      latencySamples: 95,
      p50LatencyMs: 120,
      p95LatencyMs: 900,
      verdicts: 80,
      passedVerdicts: 60,
      ...overrides,
    };
  }

  describe('deriveBindingStats', () => {
    it('turns counts into rates and carries the percentiles', () => {
      expect(deriveBindingStats(window(), 50)).toEqual({
        availabilityRate: 0.9,
        paidQualityRate: 0.75,
        p50LatencyMs: 120,
        p95LatencyMs: 900,
      });
    });

    it('keeps every field absent below the minimum sample — the neutral prior, exactly as today', () => {
      const stats = deriveBindingStats(
        window({ attempts: 49, availableAttempts: 0, latencySamples: 49, verdicts: 49 }),
        50,
      );
      expect(stats).toEqual({});
      // Absent, not `undefined`-valued: a spread over the provider's figure
      // must not erase it.
      expect(Object.keys(stats)).toHaveLength(0);
    });

    it('applies the minimum per dimension, each against its own sample', () => {
      const stats = deriveBindingStats(
        window({ attempts: 200, availableAttempts: 150, latencySamples: 10, verdicts: 12 }),
        50,
      );
      expect(stats).toEqual({ availabilityRate: 0.75 });
    });

    it('counts the boundary itself as enough', () => {
      expect(
        deriveBindingStats(window({ attempts: 50, availableAttempts: 25 }), 50).availabilityRate,
      ).toBe(0.5);
    });

    it('never sets the free quality rate — free calls are not verified', () => {
      expect(deriveBindingStats(window(), 1)).not.toHaveProperty('freeQualityRate');
    });

    it('omits a percentile the window had no sample for', () => {
      const stats = deriveBindingStats(window({ p50LatencyMs: null, p95LatencyMs: null }), 50);
      expect(stats).not.toHaveProperty('p95LatencyMs');
      expect(stats.availabilityRate).toBe(0.9);
    });
  });

  describe('poolProviderStats', () => {
    it('pools rates exactly, by counts, so the busy binding weighs more', () => {
      const pooled = poolProviderStats(
        [
          window({ attempts: 900, availableAttempts: 900, verdicts: 0, passedVerdicts: 0 }),
          window({
            bindingId: 'binding-b',
            attempts: 100,
            availableAttempts: 0,
            verdicts: 0,
            passedVerdicts: 0,
          }),
        ],
        50,
      );
      expect(pooled.availabilityRate).toBe(0.9);
      expect(pooled).not.toHaveProperty('paidQualityRate');
    });

    it('reaches the minimum on the pooled sample even when no binding does alone', () => {
      const thin = window({ attempts: 30, availableAttempts: 30, latencySamples: 0, verdicts: 0 });
      expect(deriveBindingStats(thin, 50)).toEqual({});
      expect(poolProviderStats([thin, { ...thin, bindingId: 'binding-b' }], 50)).toEqual({
        availabilityRate: 1,
      });
    });

    it('weights the bindings’ percentiles by their latency samples', () => {
      const pooled = poolProviderStats(
        [
          window({ latencySamples: 300, p50LatencyMs: 100, p95LatencyMs: 1000 }),
          window({
            bindingId: 'binding-b',
            latencySamples: 100,
            p50LatencyMs: 500,
            p95LatencyMs: 3000,
          }),
        ],
        50,
      );
      expect(pooled.p50LatencyMs).toBe(200);
      expect(pooled.p95LatencyMs).toBe(1500);
    });

    it('is empty for a provider with no windows', () => {
      expect(poolProviderStats([], 50)).toEqual({});
    });
  });

  describe('mergeWindows', () => {
    it('joins the attempt and verdict halves on the binding, zero-filling a missing half', () => {
      const merged = mergeWindows(
        [
          {
            bindingId: 'binding-a',
            providerId: 'org-a',
            attempts: 10,
            availableAttempts: 9,
            latencySamples: 9,
            p50LatencyMs: 50,
            p95LatencyMs: 90,
          },
        ],
        [
          { bindingId: 'binding-a', providerId: 'org-a', verdicts: 5, passedVerdicts: 4 },
          { bindingId: 'binding-b', providerId: 'org-b', verdicts: 3, passedVerdicts: 3 },
        ],
      );
      expect(merged).toEqual([
        window({
          attempts: 10,
          availableAttempts: 9,
          latencySamples: 9,
          p50LatencyMs: 50,
          p95LatencyMs: 90,
          verdicts: 5,
          passedVerdicts: 4,
        }),
        window({
          bindingId: 'binding-b',
          providerId: 'org-b',
          attempts: 0,
          availableAttempts: 0,
          latencySamples: 0,
          p50LatencyMs: null,
          p95LatencyMs: null,
          verdicts: 3,
          passedVerdicts: 3,
        }),
      ]);
    });
  });

  describe('loadBindingStatsConfig', () => {
    function load(env: Record<string, string>) {
      return loadBindingStatsConfig(new ConfigService(env));
    }

    it('defaults to the last 1,000 attempts and a minimum of 50', () => {
      expect(load({})).toEqual(
        expect.objectContaining({
          windowSize: DEFAULT_BINDING_STATS_WINDOW_SIZE,
          minSampleSize: DEFAULT_BINDING_STATS_MIN_SAMPLE,
        }),
      );
    });

    it('reads both settings', () => {
      expect(load({ BINDING_STATS_WINDOW_SIZE: '200', BINDING_STATS_MIN_SAMPLE: '20' })).toEqual(
        expect.objectContaining({ windowSize: 200, minSampleSize: 20 }),
      );
    });

    it.each([
      [{ BINDING_STATS_WINDOW_SIZE: '0' }],
      [{ BINDING_STATS_WINDOW_SIZE: '1.5' }],
      [{ BINDING_STATS_WINDOW_SIZE: 'lots' }],
      [{ BINDING_STATS_WINDOW_SIZE: '1000000' }],
      [{ BINDING_STATS_MIN_SAMPLE: '0' }],
      // A minimum above the window could never be met: every provider pinned
      // to the neutral prior forever.
      [{ BINDING_STATS_WINDOW_SIZE: '100', BINDING_STATS_MIN_SAMPLE: '101' }],
    ])('refuses to boot on %j', (env) => {
      expect(() => load(env)).toThrow(/BINDING_STATS_/);
    });
  });
});
