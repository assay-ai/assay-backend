import { Money } from '@modules/chains/ports/money.types';
import {
  ProviderChainStakeKey,
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '@modules/provider/ports/provider-stake.port';

/** `stakeKey(providerId, chainId)` → staked amount. */
export type ProviderStakeSnapshot = Readonly<Record<string, Money>>;

/**
 * A `ProviderStakePort` over a fixed snapshot, for tests that need a stake
 * source without a chain.
 *
 * Keyed on the `(provider, chain)` pair like the real source: a pair with no
 * entry is absent from the result, never zero, because the port is explicit
 * that absent means "no known stake".
 */
export class InMemoryProviderStakeSource implements ProviderStakePort {
  constructor(private readonly snapshot: ProviderStakeSnapshot) {}

  stakeOn(keys: readonly ProviderChainStakeKey[]): Promise<ReadonlyMap<string, ProviderStake>> {
    const observedAt = new Date();
    const found = new Map<string, ProviderStake>();
    for (const { providerId, chainId } of keys) {
      const key = stakeKey(providerId, chainId);
      const staked = this.snapshot[key];
      if (staked) found.set(key, { providerId, chainId, staked, observedAt });
    }
    return Promise.resolve(found);
  }
}
