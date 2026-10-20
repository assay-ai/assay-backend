import { BindingAttemptRepository } from '@database/postgres/repositories/binding-attempt.repository';
import { BindingStatsRepository } from '@database/postgres/repositories/binding-stats.repository';
import { BindingStatsService } from '@modules/provider/services/binding-stats.service';

/**
 * The refresh, with its tables stubbed: prune, aggregate both halves over the
 * same window, and replace the snapshot whole. The SQL itself is pinned by
 * `test/integration/provider/binding-stats.integration.spec.ts`.
 */
describe('BindingStatsService.refresh', () => {
  const NOW = new Date('2026-10-17T12:00:00Z');
  const WEEK_AGO = new Date('2026-10-10T12:00:00Z');

  it('prunes, aggregates the window and the verdicts, and replaces the snapshot', async () => {
    const calls: string[] = [];
    const attempts = {
      prune: jest.fn(async () => {
        calls.push('prune');
        return 7;
      }),
      aggregateWindows: jest.fn(async () => {
        calls.push('aggregate');
        return [
          {
            bindingId: 'b-1',
            providerId: 'org-1',
            attempts: 60,
            availableAttempts: 59,
            latencySamples: 59,
            p50LatencyMs: 100,
            p95LatencyMs: 400,
          },
        ];
      }),
    };
    const stats = {
      aggregateVerdictWindows: jest.fn(async () => [
        { bindingId: 'b-1', providerId: 'org-1', verdicts: 55, passedVerdicts: 50 },
      ]),
      replaceAll: jest.fn(async () => undefined),
    };
    const service = new BindingStatsService(
      attempts as unknown as BindingAttemptRepository,
      stats as unknown as BindingStatsRepository,
      { windowSize: 1000, minSampleSize: 50, maxPerBuyer: 20, maxAgeMs: 7 * 24 * 60 * 60 * 1000 },
    );

    await expect(service.refresh(NOW)).resolves.toEqual({ bindings: 1, pruned: 7 });

    // The prune runs first, so the aggregate reads the window itself.
    expect(calls).toEqual(['prune', 'aggregate']);
    expect(attempts.prune).toHaveBeenCalledWith(1000, 20, WEEK_AGO);
    expect(attempts.aggregateWindows).toHaveBeenCalledWith(1000, 20, WEEK_AGO);
    expect(stats.aggregateVerdictWindows).toHaveBeenCalledWith({
      windowSize: 1000,
      maxPerBuyer: 20,
      since: WEEK_AGO,
      qualityStatuses: ['PASS', 'FAIL'],
      passStatus: 'PASS',
    });
    expect(stats.replaceAll).toHaveBeenCalledWith(
      [
        {
          bindingId: 'b-1',
          providerId: 'org-1',
          attempts: 60,
          availableAttempts: 59,
          latencySamples: 59,
          p50LatencyMs: 100,
          p95LatencyMs: 400,
          verdicts: 55,
          passedVerdicts: 50,
        },
      ],
      NOW,
    );
  });
});
