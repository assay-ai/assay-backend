import {
  fakeMetricsRepository,
  fakeSlashProposalRepository,
} from '../operator/helpers/fake-metrics';
import {
  fakeOAuthSignalsReader,
  fakeObservabilityMetricsRepository,
  fakeReconciliationRunRepository,
  FakeOAuthSignals,
  FakeObservabilityOverrides,
} from './helpers/fake-observability-repositories';

import { MetricsCollectorService } from '@modules/observability/services/metrics-collector.service';
import { OAuthSignalsReader } from '@modules/observability/services/oauth-signals.reader';
import { DataSource } from 'typeorm';
import { hungCache } from '../oauth/helpers/oauth-fakes';
import { SignalAvailability } from '@modules/observability/domain/signal-catalog';
import { ReconciliationSeverity } from '@modules/settlement/ports/reconciliation.types';
import { ReconciliationRunEntity } from '@database/postgres/entities/reconciliation-run.entity';
import { SignalReadingDto } from '@modules/observability/dto/metrics-snapshot.dto';

function build(
  options: {
    runs?: Array<Partial<ReconciliationRunEntity>>;
    observability?: FakeObservabilityOverrides;
    falsePositive?: { resolved: number; falsePositives: number };
    intentRateCounts?: { lastMinute: number; hourAgoMinute: number };
    verificationBacklog?: { count: number; p95AgeSeconds: number | null };
    oauth?: FakeOAuthSignals;
  } = {},
) {
  const collector = new MetricsCollectorService(
    fakeReconciliationRunRepository(options.runs ?? []),
    fakeMetricsRepository({
      intentRateCounts: options.intentRateCounts,
      verificationBacklog: options.verificationBacklog,
    }),
    fakeSlashProposalRepository(options.falsePositive),
    fakeObservabilityMetricsRepository(options.observability),
    fakeOAuthSignalsReader(options.oauth),
  );
  return { collector };
}

function findSignal(snapshotSignals: SignalReadingDto[], signal: string): SignalReadingDto {
  const row = snapshotSignals.find((s) => s.signal === signal);
  if (!row) throw new Error(`no signal reading for ${signal}`);
  return row;
}

describe('MetricsCollectorService', () => {
  it('returns nulls, not NaN or fabricated zeros, against an empty database', async () => {
    const { collector } = build();

    const snapshot = await collector.snapshot();

    expect(snapshot.reconciliation).toEqual([]);
    expect(snapshot.failRateByPolicy).toEqual([]);

    const toolCallSuccess = findSignal(snapshot.signals, 'TOOL_CALL_SUCCESS_RATE');
    expect(toolCallSuccess.value).toBeNull();
    expect(toolCallSuccess.gate).toBeNull();

    const disputeOverturn = findSignal(snapshot.signals, 'DISPUTE_OVERTURN_RATE');
    expect(disputeOverturn.value).toBeNull();

    const openHoldAge = findSignal(snapshot.signals, 'OPEN_HOLD_AGE');
    expect(openHoldAge.value).toBeNull();
  });

  it('marks NONE-availability signals absent regardless of any value supplied', async () => {
    const { collector } = build();

    const snapshot = await collector.snapshot();

    const gasRunway = findSignal(snapshot.signals, 'GAS_RUNWAY_DAYS');
    expect(gasRunway.availability).toBe(SignalAvailability.NONE);
    expect(gasRunway.value).toBeNull();

    const falseNegative = findSignal(snapshot.signals, 'FALSE_NEGATIVE_RATE');
    expect(falseNegative.availability).toBe(SignalAvailability.NONE);
    expect(falseNegative.value).toBeNull();

    const payoutLag = findSignal(snapshot.signals, 'PAYOUT_LAG_P95');
    expect(payoutLag.availability).toBe(SignalAvailability.NONE);
    expect(payoutLag.value).toBeNull();
  });

  it('marks the two uninstrumented signals NONE with a null value', async () => {
    const { collector } = build();

    const snapshot = await collector.snapshot();

    const latency = findSignal(snapshot.signals, 'PLATFORM_LATENCY_P95_BY_BINDING');
    expect(latency.availability).toBe(SignalAvailability.NONE);
    expect(latency.value).toBeNull();

    const egress = findSignal(snapshot.signals, 'EGRESS_BLOCKS');
    expect(egress.availability).toBe(SignalAvailability.NONE);
    expect(egress.value).toBeNull();
  });

  it('never grades the false-positive proxy against the golden-signal gate', async () => {
    const { collector } = build({ falsePositive: { resolved: 40, falsePositives: 4 } });

    const snapshot = await collector.snapshot();

    const falsePositive = findSignal(snapshot.signals, 'FALSE_POSITIVE_RATE');
    expect(falsePositive.value).toBeCloseTo(0.1);
    // 0.1 would be well past the doc's 5% page threshold if graded — the
    // absence of a gate here is the point, not an oversight. See
    // SIGNAL_CATALOG's FALSE_POSITIVE_RATE reason and golden-signals.ts's
    // own docstring on GoldenSignal.FALSE_POSITIVE_RATE.
    expect(falsePositive.gate).toBeNull();
  });

  it('computes reserve health from the latest run per asset and gates it via evaluateReserveHealth', async () => {
    const { collector } = build({
      runs: [
        {
          assetId: 'usdc',
          decimals: 6,
          difference: '-1000000', // -1 USDC display unit
          severity: ReconciliationSeverity.CRITICAL,
          startedAt: new Date(Date.now() - 5000),
        } as Partial<ReconciliationRunEntity>,
      ],
    });

    const snapshot = await collector.snapshot();

    expect(snapshot.reconciliation).toHaveLength(1);
    const row = snapshot.reconciliation[0];
    expect(row.asset).toBe('usdc');
    expect(row.differenceDisplay).toBeCloseTo(-1);
    expect(row.gate?.status).toBe('CRITICAL');
    expect(row.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports a healthy reserve as an OK gate, not a null one', async () => {
    const { collector } = build({
      runs: [
        {
          assetId: 'usdc',
          decimals: 6,
          difference: '5000000',
          severity: ReconciliationSeverity.OK,
          startedAt: new Date(),
        } as Partial<ReconciliationRunEntity>,
      ],
    });

    const snapshot = await collector.snapshot();

    expect(snapshot.reconciliation[0].gate?.status).toBe('OK');
  });

  it('divides FAIL rate by policy correctly and passes rows through unaggregated', async () => {
    const { collector } = build({
      observability: {
        failRateByPolicy: [
          { policyId: 'policy-a', policyVersion: 3, total: 20, fail: 4 },
          { policyId: 'policy-b', policyVersion: 1, total: 5, fail: 5 },
        ],
      },
    });

    const snapshot = await collector.snapshot();

    expect(snapshot.failRateByPolicy).toEqual([
      { policyId: 'policy-a', policyVersion: 3, total: 20, failRate: 0.2 },
      { policyId: 'policy-b', policyVersion: 1, total: 5, failRate: 1 },
    ]);
  });

  it('computes tool-call success rate and grades it against the 97% warn gate', async () => {
    const { collector } = build({
      observability: { toolCallSuccessRate: { total: 100, nonSystemError: 90 } },
    });

    const snapshot = await collector.snapshot();

    const reading = findSignal(snapshot.signals, 'TOOL_CALL_SUCCESS_RATE');
    expect(reading.value).toBeCloseTo(0.9);
    expect(reading.gate?.status).toBe('WARN');
  });

  it('computes dispute overturn rate from raised/overturned counts, 0 raised as null not NaN', async () => {
    const { collector } = build({
      observability: { disputeOverturnCounts: { raised: 10, overturned: 3 } },
    });

    const snapshot = await collector.snapshot();

    const reading = findSignal(snapshot.signals, 'DISPUTE_OVERTURN_RATE');
    expect(reading.value).toBeCloseTo(0.3);
  });

  it('caches the snapshot within the TTL — one round of repository calls serves many requests', async () => {
    const { collector } = build({ observability: { attestationsSigned: 7 } });

    const first = await collector.snapshot();
    const second = await collector.snapshot();

    expect(second.generatedAt).toBe(first.generatedAt);
  });

  it('refreshes after the TTL elapses', async () => {
    process.env.OBSERVABILITY_METRICS_CACHE_TTL_MS = '1';
    try {
      const { collector } = build();

      const first = await collector.snapshot();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await collector.snapshot();

      expect(second.generatedAt).not.toBe(first.generatedAt);
    } finally {
      delete process.env.OBSERVABILITY_METRICS_CACHE_TTL_MS;
    }
  });

  describe('OAuth signals (spec §6.7)', () => {
    const OAUTH_SIGNALS = [
      'OAUTH_LIVE_GRANTS',
      'OAUTH_LIVE_GRANTS_PER_AGENT_MAX',
      'OAUTH_GRANTS_STOPPED_FOR_REUSE',
      'OAUTH_REFRESH_STALE_REUSE',
      'OAUTH_REFRESH_GRACE_USES',
      'OAUTH_DCR_REGISTRATIONS',
      'OAUTH_CIMD_CLIENTS',
      'OAUTH_TOKEN_RESULTS',
      'OAUTH_CONSENT_STEPS',
      'OAUTH_CONTINUE_COOKIE_MISSING',
      'OAUTH_AUTHORIZE_OUTCOMES',
      'OAUTH_CIMD_FETCHES',
      'MCP_UNAUTHORIZED',
    ];

    async function oauthSnapshot(oauth: FakeOAuthSignals) {
      const { collector } = build({ oauth });
      const snapshot = await collector.snapshot();
      return (name: string) => findSignal(snapshot.signals, name);
    }

    it('reports every OAuth signal in the oauth section, sourced, zero against empty sources', async () => {
      const signal = await oauthSnapshot({});
      for (const name of OAUTH_SIGNALS) {
        const row = signal(name);
        expect(row.section).toBe('oauth');
        expect(row.availability).toBe(SignalAvailability.SOURCED);
        expect(row.value).toBe(0);
        expect(row.gate?.status ?? 'OK').toBe('OK');
      }
    });

    it('OAUTH_LIVE_GRANTS: the live grant count, no gate', async () => {
      const signal = await oauthSnapshot({ database: { liveGrants: 312 } });
      expect(signal('OAUTH_LIVE_GRANTS')).toMatchObject({ value: 312, unit: 'grants', gate: null });
    });

    it('OAUTH_LIVE_GRANTS_PER_AGENT_MAX: warns at 45, OK at 44', async () => {
      const at44 = await oauthSnapshot({ database: { maxLiveGrantsPerAgent: 44 } });
      expect(at44('OAUTH_LIVE_GRANTS_PER_AGENT_MAX').gate?.status).toBe('OK');

      const at45 = await oauthSnapshot({ database: { maxLiveGrantsPerAgent: 45 } });
      const row = at45('OAUTH_LIVE_GRANTS_PER_AGENT_MAX');
      expect(row.value).toBe(45);
      expect(row.gate?.status).toBe('WARN');
      expect(row.gate?.summary).toContain('45');
    });

    it('OAUTH_GRANTS_STOPPED_FOR_REUSE: refresh plus code reuse; any one is critical', async () => {
      const none = await oauthSnapshot({});
      expect(none('OAUTH_GRANTS_STOPPED_FOR_REUSE').gate?.status).toBe('OK');

      const signal = await oauthSnapshot({
        database: { stoppedForRefreshReuse: 1, stoppedForCodeReuse: 2 },
      });
      const row = signal('OAUTH_GRANTS_STOPPED_FOR_REUSE');
      expect(row.value).toBe(3);
      expect(row.extra).toEqual({ refreshReuse: 1, codeReuse: 2 });
      expect(row.gate?.status).toBe('CRITICAL');
    });

    it('OAUTH_REFRESH_STALE_REUSE and OAUTH_REFRESH_GRACE_USES: audit counts, no gate', async () => {
      const signal = await oauthSnapshot({
        database: { refreshStaleReuse: 4, refreshGraceUses: 9 },
      });
      expect(signal('OAUTH_REFRESH_STALE_REUSE')).toMatchObject({ value: 4, gate: null });
      expect(signal('OAUTH_REFRESH_GRACE_USES')).toMatchObject({
        value: 9,
        unit: 'count / 24h',
        gate: null,
      });
    });

    it('OAUTH_DCR_REGISTRATIONS: warns at 1000 a day, or above 100 under one client_name', async () => {
      const ok = await oauthSnapshot({
        database: { dcrRegistrations: 999, dcrMaxPerClientName: 100 },
      });
      expect(ok('OAUTH_DCR_REGISTRATIONS')).toMatchObject({
        value: 999,
        extra: { maxPerClientName: 100 },
        gate: { status: 'OK' },
      });

      const total = await oauthSnapshot({ database: { dcrRegistrations: 1000 } });
      expect(total('OAUTH_DCR_REGISTRATIONS').gate?.status).toBe('WARN');

      const oneName = await oauthSnapshot({
        database: { dcrRegistrations: 120, dcrMaxPerClientName: 101 },
      });
      const row = oneName('OAUTH_DCR_REGISTRATIONS');
      expect(row.gate?.status).toBe('WARN');
      expect(row.gate?.summary).toContain('client_name');
    });

    it('OAUTH_CIMD_CLIENTS: the CIMD client rows, no gate', async () => {
      const signal = await oauthSnapshot({ database: { cimdClients: 17 } });
      expect(signal('OAUTH_CIMD_CLIENTS')).toMatchObject({ value: 17, gate: null });
    });

    it('OAUTH_TOKEN_RESULTS: the total, with each non-zero grant_type.result', async () => {
      const signal = await oauthSnapshot({
        counters: {
          last24h: {
            token: {
              'authorization_code.ok': 5,
              'refresh_token.ok': 20,
              'refresh_token.invalid_grant': 2,
            },
          },
        },
      });
      expect(signal('OAUTH_TOKEN_RESULTS')).toMatchObject({
        value: 27,
        gate: null,
        extra: {
          'authorization_code.ok': 5,
          'refresh_token.ok': 20,
          'refresh_token.invalid_grant': 2,
        },
      });
    });

    it('OAUTH_CONSENT_STEPS: approved as the value, every step in extra', async () => {
      const signal = await oauthSnapshot({
        counters: { last24h: { consent: { shown: 12, approved: 10, denied: 1 } } },
      });
      expect(signal('OAUTH_CONSENT_STEPS')).toMatchObject({
        value: 10,
        extra: { shown: 12, approved: 10, denied: 1 },
      });
    });

    it('OAUTH_CONTINUE_COOKIE_MISSING: warns above 5% of approved in the last hour', async () => {
      const within = await oauthSnapshot({
        counters: { lastHour: { consentApproved: 40, continueCookieMissing: 2 } },
      });
      expect(within('OAUTH_CONTINUE_COOKIE_MISSING')).toMatchObject({
        value: 2,
        unit: 'count / 1h',
        gate: { status: 'OK' },
      });

      const above = await oauthSnapshot({
        counters: {
          last24h: { consent: { continue_cookie_missing: 6 } },
          lastHour: { consentApproved: 40, continueCookieMissing: 3 },
        },
      });
      const row = above('OAUTH_CONTINUE_COOKIE_MISSING');
      expect(row.gate?.status).toBe('WARN');
      expect(row.extra).toEqual({ approvedLastHour: 40, missingLast24h: 6 });

      const noApprovals = await oauthSnapshot({
        counters: { lastHour: { consentApproved: 0, continueCookieMissing: 1 } },
      });
      expect(noApprovals('OAUTH_CONTINUE_COOKIE_MISSING').gate?.status).toBe('WARN');
    });

    it('OAUTH_AUTHORIZE_OUTCOMES: stored as the value, every outcome in extra', async () => {
      const signal = await oauthSnapshot({
        counters: { last24h: { authorize: { stored: 30, rate_limited: 2 } } },
      });
      expect(signal('OAUTH_AUTHORIZE_OUTCOMES')).toMatchObject({
        value: 30,
        extra: { stored: 30, rate_limited: 2 },
        gate: null,
      });
    });

    it('OAUTH_CIMD_FETCHES: warns on any blocked_address', async () => {
      const ok = await oauthSnapshot({ counters: { last24h: { cimd_fetch: { ok: 8 } } } });
      expect(ok('OAUTH_CIMD_FETCHES')).toMatchObject({ value: 8, gate: { status: 'OK' } });

      const blocked = await oauthSnapshot({
        counters: { last24h: { cimd_fetch: { ok: 8, blocked_address: 1 } } },
      });
      const row = blocked('OAUTH_CIMD_FETCHES');
      expect(row.value).toBe(9);
      expect(row.gate?.status).toBe('WARN');
      expect(row.extra).toEqual({ ok: 8, blocked_address: 1 });
    });

    it('MCP_UNAUTHORIZED: the 401s by reason', async () => {
      const signal = await oauthSnapshot({
        counters: { last24h: { mcp_unauthorized: { missing: 50, revoked: 3 } } },
      });
      expect(signal('MCP_UNAUTHORIZED')).toMatchObject({
        value: 53,
        extra: { missing: 50, revoked: 3 },
        gate: null,
      });
    });

    it('a failed database read shows the database signals absent, never zero, and keeps the counters', async () => {
      const signal = await oauthSnapshot({
        database: null,
        counters: { last24h: { token: { 'refresh_token.ok': 2 } } },
      });
      for (const name of [
        'OAUTH_LIVE_GRANTS',
        'OAUTH_LIVE_GRANTS_PER_AGENT_MAX',
        'OAUTH_GRANTS_STOPPED_FOR_REUSE',
        'OAUTH_DCR_REGISTRATIONS',
        'OAUTH_CIMD_CLIENTS',
      ]) {
        expect(signal(name)).toMatchObject({ value: null, gate: null });
        expect(signal(name).reason).toContain('Source unavailable');
      }
      expect(signal('OAUTH_TOKEN_RESULTS').value).toBe(2);
      expect(signal('OAUTH_TOKEN_RESULTS').reason).not.toContain('Source unavailable');
    });

    it('unreachable counters show the counter signals absent and keep the database ones', async () => {
      const signal = await oauthSnapshot({ database: { liveGrants: 3 }, counters: null });
      for (const name of [
        'OAUTH_TOKEN_RESULTS',
        'OAUTH_CONSENT_STEPS',
        'OAUTH_CONTINUE_COOKIE_MISSING',
        'OAUTH_CIMD_FETCHES',
        'MCP_UNAUTHORIZED',
      ]) {
        expect(signal(name)).toMatchObject({ value: null, gate: null });
        expect(signal(name).extra).toBeUndefined();
        expect(signal(name).reason).toContain('Source unavailable');
      }
      expect(signal('OAUTH_LIVE_GRANTS').value).toBe(3);
    });
  });

  it('a hung OAuth source never holds the money and traffic rows (M1-I2)', async () => {
    const hung = new OAuthSignalsReader(
      { query: () => new Promise(() => undefined) } as unknown as DataSource,
      hungCache(),
    );
    const collector = new MetricsCollectorService(
      fakeReconciliationRunRepository([]),
      fakeMetricsRepository({}),
      fakeSlashProposalRepository(),
      fakeObservabilityMetricsRepository({
        toolCallSuccessRate: { total: 10, nonSystemError: 10 },
      }),
      hung,
    );

    const started = Date.now();
    const snapshot = await collector.snapshot();
    expect(Date.now() - started).toBeLessThan(2500);

    expect(findSignal(snapshot.signals, 'TOOL_CALL_SUCCESS_RATE').value).toBe(1);
    expect(findSignal(snapshot.signals, 'OAUTH_LIVE_GRANTS').value).toBeNull();
    expect(findSignal(snapshot.signals, 'OAUTH_TOKEN_RESULTS').value).toBeNull();
  });
});
