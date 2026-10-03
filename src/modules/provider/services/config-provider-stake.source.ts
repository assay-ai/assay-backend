import { Inject, Injectable } from '@nestjs/common';

import { Money } from '@modules/chains/ports/money.types';

import {
  ProviderChainStakeKey,
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '../ports/provider-stake.port';

/**
 * Stake read from configuration — the first stage of a two-stage arrangement.
 *
 * The chain is authoritative and this value is a cache of it. Before the
 * on-chain read existed there was no chain to cache, so this was the *whole*
 * source, seeded by an operator, and it is honest about that rather
 * than pretending to be a cache of something that does not exist yet.
 *
 * What it must not become is load-bearing. The gate it feeds decides whether a
 * paid call is backed by collateral, and an operator-typed number is a claim
 * about collateral, not collateral. Two things follow, and both are why this
 * class is deliberately dull:
 *
 * - It holds no logic worth keeping. Swapping it for the on-chain source at
 *   is a `useClass` change in `ProviderModule` — nothing in the router
 *   or the gate moves.
 * - It goes to **mainnet only behind the reconciler**, which compares
 *   ledger stake against chain stake every 5 minutes. Until the chain read
 *   exists there is nothing to reconcile against, which is the real reason this
 *   is a testnet-and-staging arrangement rather than a shipping one.
 */
export const PROVIDER_STAKE_SNAPSHOT = 'PROVIDER_STAKE_SNAPSHOT';

/**
 * `stakeKey(providerId, chainId)` → staked amount, as configured.
 *
 * Keyed on the pair, not on the provider: an operator seeding a stake is making
 * a claim about collateral that some chain's settlement contract could reach,
 * and there is no such contract that can reach "the provider". A single-key
 * snapshot would have to answer every chain with the same number, which is the
 * bootstrap discount the per-chain stake rule forbids, spelled as a data shape.
 */
export type ProviderStakeSnapshot = Readonly<Record<string, Money>>;

@Injectable()
export class ConfigProviderStakeSource implements ProviderStakePort {
  constructor(@Inject(PROVIDER_STAKE_SNAPSHOT) private readonly snapshot: ProviderStakeSnapshot) {}

  stakeOn(keys: readonly ProviderChainStakeKey[]): Promise<ReadonlyMap<string, ProviderStake>> {
    const observedAt = new Date();
    const found = new Map<string, ProviderStake>();

    for (const { providerId, chainId } of keys) {
      const key = stakeKey(providerId, chainId);
      const staked = this.snapshot[key];
      // A pair with no entry is simply absent from the result. Not zero — the
      // port is explicit that absent means "no known stake", and the gate
      // refuses both, but only one of them means the source failed. A provider
      // seeded on one chain and not another is absent on the second, which is
      // the whole point of keying the snapshot on the pair.
      if (staked) found.set(key, { providerId, chainId, staked, observedAt });
    }

    return Promise.resolve(found);
  }
}
