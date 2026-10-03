import {
  OnChainStake,
  OnChainStakeReaderPort,
} from '@modules/provider/ports/onchain-stake-reader.port';

import { AccountId } from '../ports/caip.types';
import { groupByNamespace } from './namespace-dispatch';

/**
 * One `OnChainStakeReaderPort` over N namespaces.
 *
 * `ChainAdapterRegistry` already had this pattern and it was not applied here —
 * so `OnChainProviderStakeSource.stakeOn` resolves the authority per
 * `(provider, chain)` correctly and then hands the **union** to the single
 * Solana reader. With one chain that is invisible. With two it asks a Solana RPC
 * about an `0x` address, gets "no account", and an absent stake reading fails
 * the routing gate closed — which reads as *every EVM provider is unstaked*, on
 * a deployment where nothing is wrong.
 *
 * ## Why a failure is a THROW and not a partial map
 *
 * The caller treats a successful read as **authoritative** and discards a cached
 * reading for any account the chain said nothing about:
 *
 * ```ts
 * if (readSucceeded && asked.has(account)) continue;   // onchain-provider-stake.source.ts
 * ```
 *
 * So a multiplexer that swallowed one namespace's failure and returned the other
 * namespace's answer would set `readSucceeded = true` for accounts nobody
 * successfully read — turning an EVM RPC outage into "every EVM provider has no
 * stake account" *and* deleting the good cached readings that would have carried
 * them through it. That is the stake-visibility race after a deposit, arriving
 * from a new direction.
 *
 * Throwing puts the caller back on the path it was written for: it logs, keeps
 * `readSucceeded` false, and serves readings up to `staleMaxMs` old. The cost is
 * that one chain's outage also costs the *other* chain a refresh for that tick —
 * cheap, because the other chain's readings are cached and the next tick tries
 * again.
 */
export class NamespaceStakeReader implements OnChainStakeReaderPort {
  constructor(private readonly byNamespace: ReadonlyMap<string, OnChainStakeReaderPort>) {}

  async bondedStakeOf(
    accounts: readonly AccountId[],
  ): Promise<ReadonlyMap<AccountId, OnChainStake>> {
    // Every unserved namespace is refused here, before any RPC call is made.
    const grouped = groupByNamespace(accounts, this.byNamespace);
    const merged = new Map<AccountId, OnChainStake>();

    // Sequential, not `Promise.all`: `DepositFinalityWatcher` already taught
    // this codebase what an unsettled `Promise.all` costs at boot, and the whole
    // read is behind a cache that makes two round trips in series unremarkable.
    for (const [namespace, subset] of grouped) {
      const partial = await this.byNamespace.get(namespace)!.bondedStakeOf(subset);
      for (const [key, value] of partial) {
        merged.set(key, value);
      }
    }

    return merged;
  }
}
