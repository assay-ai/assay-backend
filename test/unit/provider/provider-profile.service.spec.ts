import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { ProviderRegistryPort } from '@modules/provider/ports/provider-registry.port';
import { ProviderStatus, ProviderTier } from '@modules/provider/ports/provider.types';
import { ProviderProfileService } from '@modules/provider/services/provider-profile.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const ORG = 'org-11111111-1111-4111-8111-111111111111';

function build(states: Record<string, unknown> = {}) {
  const findRoutingStates = jest.fn().mockResolvedValue(new Map(Object.entries(states)));
  const registry = { findRoutingStates } as unknown as ProviderRegistryPort;
  return { service: new ProviderProfileService(registry), registry };
}

describe('ProviderProfileService — the calling organization is the provider id', () => {
  it('returns the routing state keyed by the caller’s own organizationId', async () => {
    const { service, registry } = build({
      [ORG]: {
        status: ProviderStatus.ACTIVE,
        tier: ProviderTier.ESTABLISHED,
        stats: { paidQualityRate: 0.97, callsServed: 10_000 },
      },
    });

    const me = await service.getMe(ORG);

    expect(registry.findRoutingStates).toHaveBeenCalledWith([ORG]);
    expect(me.id).toBe(ORG);
    expect(me.status).toBe(ProviderStatus.ACTIVE);
    expect(me.tier).toBe(ProviderTier.ESTABLISHED);
    expect(me.stats.paidQualityRate).toBe(0.97);
    expect(me.stats.callsServed).toBe(10_000);
  });

  it('never serializes an unmeasured stat as 0 — absent stays null', async () => {
    const { service } = build({
      [ORG]: { status: ProviderStatus.ACTIVE, tier: ProviderTier.NEW, stats: {} },
    });

    const me = await service.getMe(ORG);

    expect(me.stats).toEqual({
      availabilityRate: null,
      paidQualityRate: null,
      freeQualityRate: null,
      p50LatencyMs: null,
      p95LatencyMs: null,
      callsServed: null,
      upheldSlashes: null,
    });
  });

  it('404s — never throws Forbidden — when the registry has no entry for this organization', async () => {
    const { service } = build({});

    await expectErrorCodeAsync(() => service.getMe(ORG), ProviderErrorCode.PROVIDER_NOT_FOUND);
  });
});
