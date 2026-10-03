import { Inject, Injectable } from '@nestjs/common';

import { ProviderRegistryPort } from '../ports/provider-registry.port';
import { ProviderRoutingState } from '../ports/provider.types';

/**
 * The provider registry, from configuration.
 *
 * A stand-in for the `providers` table that open registration creates. It
 * exists because the router needs provider status, tier and statistics to
 * route, and routing landed before registration did — not because
 * configuration is a reasonable place to keep a provider directory.
 *
 * Replaced wholesale by `DbProviderRegistry`. Nothing depends on this class;
 * the router depends on {@link ProviderRegistryPort}.
 */
export const PROVIDER_REGISTRY_SNAPSHOT = 'PROVIDER_REGISTRY_SNAPSHOT';

export type ProviderRegistrySnapshot = Readonly<Record<string, ProviderRoutingState>>;

@Injectable()
export class ConfigProviderRegistry implements ProviderRegistryPort {
  constructor(
    @Inject(PROVIDER_REGISTRY_SNAPSHOT) private readonly snapshot: ProviderRegistrySnapshot,
  ) {}

  findRoutingStates(
    providerIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderRoutingState>> {
    const found = new Map<string, ProviderRoutingState>();

    for (const providerId of providerIds) {
      const state = this.snapshot[providerId];
      if (state) found.set(providerId, state);
    }

    return Promise.resolve(found);
  }
}
