import { Inject, Injectable } from '@nestjs/common';

import { GetProviderMeResponseDto, ProviderStatsDto } from '../dto/get-provider-me.dto';
import { ProviderErrors } from '../errors/provider.errors';
import { PROVIDER_REGISTRY, ProviderRegistryPort } from '../ports/provider-registry.port';
import { ProviderRoutingState } from '../ports/provider.types';

/**
 * `GET /providers/me`.
 *
 * **The core assumption this whole module rests on**: `providerId ===
 * organizationId`. `ProviderRegistryPort`/`ProviderStakePort` are keyed by an opaque
 * `providerId` string with no link back to an organization anywhere in the
 * schema — `payment_intents.provider_id` and `tool_bindings.providerId` are
 * both bare ids with no FK. Treating the calling organization's own id as its
 * provider id is the only self-consistent reading of "the provider record for
 * the calling org" with today's schema, and it is what makes `session.
 * organizationId` a valid key into both provider ports everywhere in this
 * module. The `providers` table keeps it: `providers.organization_id` is
 * `UNIQUE` — see `provider-registration.types.ts` for why no second id was
 * minted.
 */
@Injectable()
export class ProviderProfileService {
  constructor(@Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistryPort) {}

  async getMe(organizationId: string): Promise<GetProviderMeResponseDto> {
    const states = await this.registry.findRoutingStates([organizationId]);
    const state = states.get(organizationId);

    if (!state) {
      throw ProviderErrors.providerNotFound({ providerId: organizationId });
    }

    return {
      id: organizationId,
      status: state.status,
      tier: state.tier,
      stats: toStatsDto(state),
      slashHolds: (state.slashHolds ?? []).map((hold) => ({
        chainId: hold.chainId,
        reasons: [...hold.reasons],
        heldSince: hold.heldSince.toISOString(),
      })),
    };
  }
}

function toStatsDto(state: ProviderRoutingState): ProviderStatsDto {
  const stats = state.stats;
  return {
    availabilityRate: stats.availabilityRate ?? null,
    paidQualityRate: stats.paidQualityRate ?? null,
    freeQualityRate: stats.freeQualityRate ?? null,
    p50LatencyMs: stats.p50LatencyMs ?? null,
    p95LatencyMs: stats.p95LatencyMs ?? null,
    callsServed: stats.callsServed ?? null,
    upheldSlashes: stats.upheldSlashes ?? null,
  };
}
