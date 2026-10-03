import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { ProviderSlaWindowsService } from '@modules/provider/services/provider-sla-windows.service';
import { SlaWindowConfig } from '@modules/provider/constants/sla-window.constants';
import { SortDirection } from '@shared/api';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder } from './helpers/fake-query-builder';

const ORG = 'org-99999999-9999-4999-8999-999999999999';
const BINDING = 'binding-1';
const WINDOW = 'window-1';

const CONFIG: SlaWindowConfig = {
  minVerifiedCalls: 400,
  zScore: 2.58,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  warningRatio: 0.8,
  warningMinSampleFraction: 0.25,
  penaltyMultiplier: 2,
  now: () => Date.parse('2026-08-20T00:00:00.000Z'),
};

function windowRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: WINDOW,
    organizationId: ORG,
    providerId: ORG,
    bindingId: BINDING,
    toolId: 'search_web',
    sequence: 3,
    status: 'OPEN',
    outcome: null,
    openedAt: new Date('2026-08-15T00:00:00.000Z'),
    deadlineAt: new Date('2026-08-22T00:00:00.000Z'),
    closedAt: null,
    declaredFailureRate: '0.05000',
    minVerifiedCalls: 400,
    zScore: 2.58,
    maxAgeMs: String(7 * 24 * 60 * 60 * 1000),
    warningRatio: 0.8,
    warningMinSampleFraction: 0.25,
    penaltyMultiplier: 2,
    totalCalls: 300,
    verifiedCalls: 200,
    failedCalls: 8,
    totalCallAmount: '2000000',
    assetId: 'usdc',
    warningLevel: null,
    warnedAt: null,
    criticalWarnedAt: null,
    samplingEscalationRequested: false,
    ...overrides,
  };
}

function build(
  overrides: {
    windows?: Record<string, unknown>;
    calls?: Record<string, unknown>;
    bindings?: Record<string, unknown>;
  } = {},
) {
  const windows = {
    createQueryBuilder: jest.fn(),
    findOneBy: jest.fn(),
    findOpenForBinding: jest.fn(),
    ...overrides.windows,
  };
  const calls = {
    findByWindow: jest.fn().mockResolvedValue([]),
    countFailuresByReasonCode: jest.fn().mockResolvedValue([]),
    countFailuresByAgentId: jest.fn().mockResolvedValue([]),
    ...overrides.calls,
  };
  const bindings = {
    findOneBy: jest.fn(),
    ...overrides.bindings,
  };

  const service = new ProviderSlaWindowsService(
    windows as any,
    calls as any,
    bindings as any,
    CONFIG,
  );

  return { service, windows, calls, bindings };
}

describe('ProviderSlaWindowsService.listWindows', () => {
  it('scopes to the caller’s own organization, not cross-org', async () => {
    const fake = fakeQueryBuilder([]);
    const { service, windows } = build();
    windows.createQueryBuilder.mockReturnValue(fake.qb);

    await service.listWindows(ORG, { limit: 25, order: SortDirection.DESC } as any);

    expect(fake.wheres[0]).toEqual({
      sql: 'window.organizationId = :organizationId',
      params: { organizationId: ORG },
    });
  });

  it('applies bindingId / status / outcome filters when given', async () => {
    const fake = fakeQueryBuilder([]);
    const { service, windows } = build();
    windows.createQueryBuilder.mockReturnValue(fake.qb);

    await service.listWindows(ORG, {
      limit: 25,
      order: SortDirection.DESC,
      bindingId: BINDING,
      status: 'CLOSED',
      outcome: 'WITHIN_SLA',
    } as any);

    const sql = fake.wheres.map((w) => w.sql).join(' | ');
    expect(sql).toContain('window.bindingId = :bindingId');
    expect(sql).toContain('window.status = :status');
    expect(sql).toContain('window.outcome = :outcome');
  });

  it('renders each row with its label and observed rate', async () => {
    const fake = fakeQueryBuilder([windowRow()]);
    const { service, windows } = build();
    windows.createQueryBuilder.mockReturnValue(fake.qb);

    const page = await service.listWindows(ORG, { limit: 25, order: SortDirection.DESC } as any);

    expect(page.items[0]).toMatchObject({
      windowId: WINDOW,
      label: 'w_3',
      declaredFailureRate: 0.05,
      verifiedCalls: 200,
      failedCalls: 8,
      observedFailureRate: 0.04,
    });
  });
});

describe('ProviderSlaWindowsService.getWindow', () => {
  it('throws PROVIDER_SLA_WINDOW_NOT_FOUND when nothing matches', async () => {
    const { service, windows } = build();
    windows.findOneBy.mockResolvedValue(null);

    await expectErrorCodeAsync(
      () => service.getWindow(ORG, WINDOW),
      ProviderErrorCode.PROVIDER_SLA_WINDOW_NOT_FOUND,
    );
  });

  it('computes the live position from the stored counters — below the sample gate', async () => {
    const { service, windows } = build();
    windows.findOneBy.mockResolvedValue(windowRow({ verifiedCalls: 200, failedCalls: 8 }));

    const result = await service.getWindow(ORG, WINDOW);

    expect(result.state).toBe('BELOW_SAMPLE_GATE');
    expect(result.slashable).toBe(false);
    expect(result.projectedSampleAtClose).toBe(400);
  });

  it('projects a breach when the observed rate already exceeds the effective threshold', async () => {
    const { service, windows } = build();
    // 200 verified, 40 failed — 20% observed against a 5% declaration: well past threshold.
    windows.findOneBy.mockResolvedValue(windowRow({ verifiedCalls: 200, failedCalls: 40 }));

    const result = await service.getWindow(ORG, WINDOW);

    expect(result.state).toBe('PROJECTED_BREACH');
    expect(result.projectedBreach).toBe(true);
  });
});

describe('ProviderSlaWindowsService.getEvidence', () => {
  it('throws PROVIDER_SLA_WINDOW_NOT_FOUND when nothing matches', async () => {
    const { service, windows } = build();
    windows.findOneBy.mockResolvedValue(null);

    await expectErrorCodeAsync(
      () => service.getEvidence(ORG, WINDOW),
      ProviderErrorCode.PROVIDER_SLA_WINDOW_NOT_FOUND,
    );
  });

  it('carries the calls and the two failure breakdowns', async () => {
    const { service, windows, calls } = build();
    windows.findOneBy.mockResolvedValue(windowRow());
    calls.findByWindow.mockResolvedValue([
      {
        intentId: 'intent-1',
        agentId: 'agent-1',
        verdict: 'FAIL',
        reasonCode: 'MIN_ARRAY_LENGTH',
        countedAsQuality: true,
        countedAsFailure: true,
        priceAmount: '1000',
        assetId: 'usdc',
        postedAt: new Date('2026-08-15T01:00:00.000Z'),
      },
    ]);
    calls.countFailuresByReasonCode.mockResolvedValue([{ key: 'MIN_ARRAY_LENGTH', count: '6' }]);
    calls.countFailuresByAgentId.mockResolvedValue([{ key: 'agent-1', count: '4' }]);

    const result = await service.getEvidence(ORG, WINDOW);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ intentId: 'intent-1', reasonCode: 'MIN_ARRAY_LENGTH' });
    expect(result.failuresByReasonCode).toEqual([{ key: 'MIN_ARRAY_LENGTH', count: 6 }]);
    expect(result.failuresByAgentId).toEqual([{ key: 'agent-1', count: 4 }]);
  });
});

describe('ProviderSlaWindowsService.getBindingSla — SLA workbench', () => {
  it('throws PROVIDER_BINDING_NOT_FOUND when the binding is not the caller’s own', async () => {
    const { service, bindings } = build();
    bindings.findOneBy.mockResolvedValue(null);

    await expectErrorCodeAsync(
      () => service.getBindingSla(ORG, BINDING),
      ProviderErrorCode.PROVIDER_BINDING_NOT_FOUND,
    );
  });

  it('reports no measured rate and no peers when nothing has closed yet', async () => {
    const closedAggregateFake = fakeQueryBuilder([{ verifiedCalls: '0', failedCalls: '0' }]);
    const peersFake = fakeQueryBuilder([]);
    const { service, windows, bindings } = build();
    bindings.findOneBy.mockResolvedValue({ toolId: 'search_web', slaFailureRate: '0.05000' });
    windows.findOpenForBinding.mockResolvedValue(null);
    windows.createQueryBuilder
      .mockReturnValueOnce(closedAggregateFake.qb)
      .mockReturnValueOnce(peersFake.qb);

    const result = await service.getBindingSla(ORG, BINDING);

    expect(result.measured).toBeNull();
    expect(result.inFlightWindow).toBeNull();
    expect(result.peers).toEqual({ median: null, p90: null, rank: null, count: 0 });
    // With nothing measured, n floors to minVerifiedCalls (400).
    expect(result.effectiveThreshold).toBeCloseTo(0.05 + 2.58 * Math.sqrt((0.05 * 0.95) / 400), 6);
  });

  it('computes median, p90, rank and count from closed windows across every binding on the tool', async () => {
    // Five peer bindings, ascending observed rate: 2%, 4%, 5% (this one), 8%, 10%.
    const peerRows = [
      { bindingId: 'b-2pct', verifiedCalls: '1000', failedCalls: '20' },
      { bindingId: 'b-4pct', verifiedCalls: '1000', failedCalls: '40' },
      { bindingId: BINDING, verifiedCalls: '1000', failedCalls: '50' },
      { bindingId: 'b-8pct', verifiedCalls: '1000', failedCalls: '80' },
      { bindingId: 'b-10pct', verifiedCalls: '1000', failedCalls: '100' },
    ];
    const closedAggregateFake = fakeQueryBuilder([{ verifiedCalls: '1000', failedCalls: '50' }]);
    const peersFake = fakeQueryBuilder(peerRows);
    const { service, windows, bindings } = build();
    bindings.findOneBy.mockResolvedValue({ toolId: 'search_web', slaFailureRate: '0.05000' });
    windows.findOpenForBinding.mockResolvedValue(null);
    windows.createQueryBuilder
      .mockReturnValueOnce(closedAggregateFake.qb)
      .mockReturnValueOnce(peersFake.qb);

    const result = await service.getBindingSla(ORG, BINDING);

    expect(result.measured).toMatchObject({
      verifiedCalls: 1000,
      failedCalls: 50,
      observedFailureRate: 0.05,
    });
    expect(result.peers).toEqual({ median: 0.05, p90: 0.092, rank: 3, count: 5 });

    // Cross-organization: the peer query must not filter on organizationId.
    const peerSql = peersFake.wheres.map((w) => w.sql).join(' | ');
    expect(peerSql).toContain('window.organizationId IS NOT NULL');
    expect(peerSql).not.toContain(':organizationId');
  });

  it('surfaces the open window’s frozen declared rate, which can differ from the binding’s current one', async () => {
    const closedAggregateFake = fakeQueryBuilder([{ verifiedCalls: '0', failedCalls: '0' }]);
    const peersFake = fakeQueryBuilder([]);
    const { service, windows, bindings } = build();
    bindings.findOneBy.mockResolvedValue({ toolId: 'search_web', slaFailureRate: '0.08000' });
    windows.findOpenForBinding.mockResolvedValue(windowRow({ declaredFailureRate: '0.05000' }));
    windows.createQueryBuilder
      .mockReturnValueOnce(closedAggregateFake.qb)
      .mockReturnValueOnce(peersFake.qb);

    const result = await service.getBindingSla(ORG, BINDING);

    expect(result.currentDeclaredFailureRate).toBe(0.08);
    expect(result.inFlightWindow).toMatchObject({
      windowId: WINDOW,
      label: 'w_3',
      declaredFailureRate: 0.05,
    });
  });
});
