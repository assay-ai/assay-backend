import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { ProviderSlaWindowsService } from '@modules/provider/services/provider-sla-windows.service';
import { SortDirection } from '@shared/api';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder } from './helpers/fake-query-builder';

const ORG = 'org-99999999-9999-4999-8999-999999999999';
const BINDING = 'binding-1';
const WINDOW = 'window-1';

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
  const service = new ProviderSlaWindowsService(windows as any, calls as any);

  return { service, windows, calls };
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
