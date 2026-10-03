import { ProviderRoutingState } from './provider.types';

/**
 * The provider records the router reads, minus the stake.
 *
 * Separate from {@link ProviderStakePort} on purpose — see that file. Status,
 * tier and statistics are ours and stay ours; the stake can come from the
 * chain.
 */
export interface ProviderRegistryPort {
  /**
   * Routing state for the given providers.
   *
   * A provider absent from the map is unknown to the registry, and an unknown
   * provider is not routable. A binding can outlive the provider row it points
   * at — a suspension that deleted the record, a half-applied migration — and
   * "we could not find out who serves this" must not resolve to "serve it".
   */
  findRoutingStates(
    providerIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderRoutingState>>;
}

/** DI token for the bound {@link ProviderRegistryPort}. */
export const PROVIDER_REGISTRY = 'PROVIDER_REGISTRY';
