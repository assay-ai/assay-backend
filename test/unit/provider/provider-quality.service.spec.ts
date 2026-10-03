import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { ProviderRegistryPort } from '@modules/provider/ports/provider-registry.port';
import { ProviderStatus, ProviderTier } from '@modules/provider/ports/provider.types';
import { ProviderQualityService } from '@modules/provider/services/provider-quality.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder } from './helpers/fake-query-builder';

const PROVIDER = 'org-33333333-3333-4333-8333-333333333333';
const WINDOW = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' };

function build(
  verdictRows: Array<{ verdict: string; calls: string }>,
  stats: Record<string, unknown> = {},
) {
  const fake = fakeQueryBuilder(verdictRows);
  const records = {
    createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
  } as unknown as VerificationRecordRepository;

  const findRoutingStates = jest
    .fn()
    .mockResolvedValue(
      new Map([
        [PROVIDER, { status: ProviderStatus.ACTIVE, tier: ProviderTier.ESTABLISHED, stats }],
      ]),
    );
  const registry = { findRoutingStates } as unknown as ProviderRegistryPort;

  return { service: new ProviderQualityService(registry, records), fake, registry };
}

describe('ProviderQualityService — paid/free rates come from ProviderStats, never recomputed', () => {
  it('reads paidQualityRate and freeQualityRate straight off the port, kept separate', async () => {
    const { service } = build([], {
      paidQualityRate: 0.98,
      freeQualityRate: 0.6,
      availabilityRate: 0.999,
    });

    const quality = await service.getQuality(PROVIDER, WINDOW);

    expect(quality.paidQualityRate).toBe(0.98);
    expect(quality.freeQualityRate).toBe(0.6);
    expect(quality.availabilityRate).toBe(0.999);
  });

  it('is null, not 0, when the registry has no stats for this provider', async () => {
    const fake = fakeQueryBuilder<{ verdict: string; calls: string }>([]);
    const records = {
      createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
    } as unknown as VerificationRecordRepository;
    const registry = {
      findRoutingStates: jest.fn().mockResolvedValue(new Map()),
    } as unknown as ProviderRegistryPort;

    const quality = await new ProviderQualityService(registry, records).getQuality(
      PROVIDER,
      WINDOW,
    );

    expect(quality.paidQualityRate).toBeNull();
    expect(quality.freeQualityRate).toBeNull();
    expect(quality.availabilityRate).toBeNull();
  });
});

describe('ProviderQualityService — verdictMix', () => {
  it('is a cross-organization query, scoped by provider_id', async () => {
    const { service, fake } = build([]);

    await service.getQuality(PROVIDER, WINDOW);

    const sql = fake.wheres.map((w) => w.sql).join(' ');
    expect(sql).toMatch(/organizationId/);
    expect(fake.wheres.some((w) => w.params.providerId === PROVIDER)).toBe(true);
  });

  it('computes calls and share, sorted by volume, including PENDING for unjudged calls', async () => {
    const { service } = build([
      { verdict: 'PASS', calls: '90' },
      { verdict: 'FAIL', calls: '5' },
      { verdict: 'PENDING', calls: '5' },
    ]);

    const quality = await service.getQuality(PROVIDER, WINDOW);

    expect(quality.totalCalls).toBe(100);
    expect(quality.verdictMix[0]).toEqual({ verdict: 'PASS', calls: 90, share: 0.9 });
    expect(quality.verdictMix.find((v) => v.verdict === 'PENDING')).toEqual({
      verdict: 'PENDING',
      calls: 5,
      share: 0.05,
    });
  });

  it('refuses from >= to', async () => {
    const { service } = build([]);

    await expectErrorCodeAsync(
      () => service.getQuality(PROVIDER, { from: WINDOW.to, to: WINDOW.from }),
      ProviderErrorCode.PROVIDER_INVALID_TIME_RANGE,
    );
  });
});
