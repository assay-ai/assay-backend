import { Inject, Injectable } from '@nestjs/common';

import { ENABLED_CHAINS, ENABLED_CHAINS_ENV } from './enabled-chains';
import { ChainErrors } from './errors/chains.errors';
import { ChainId, ChainNamespace, namespaceOf, parseChainId } from './ports/caip.types';
import { CHAIN_ADAPTERS, ChainAdapter } from './ports/chain-adapter.port';

/**
 * Resolves a CAIP-2 chain id to the adapter that serves it.
 *
 * Resolution is by namespace *and* network: an adapter that supports devnet
 * must not be handed a mainnet chain id just because both are `solana`. The
 * difference between those two is real money.
 *
 * Adding a chain is a registration, not a change here.
 *
 * ## The registry is where `ENABLED_CHAINS` and the adapters have to agree
 *
 * It is the only object that holds both lists, and it is built exactly once, at
 * boot, where somebody is looking. So all three of the invariants below are
 * asserted in the constructor rather than discovered at the first request:
 *
 * 1. **Every enabled chain is served** — otherwise an operator who
 *    enables `eip155:46630` on a Solana-only build learns it from a 500 on
 *    `GET /chains`, or on a deposit.
 * 2. **Nothing but an enabled chain is ever served.** `resolve()` and
 *    `enabledChains()` both read the *intersection*, so an adapter that
 *    hard-codes its `supportedChains` cannot advertise, reconcile or accept a
 *    chain the operator disabled. That direction is the original
 *    `SOLANA_ENABLED_CHAINS` bug — a devnet deployment reconciling mainnet
 *    forever and paging `RECONCILIATION_BLIND` about a vault that cannot
 *    exist — and asserting only `enabled ⊆ served` would leave it open,
 *    depending on every adapter to filter voluntarily.
 * 3. **An adapter's chains lie in its own namespace.** `resolve()` finds the
 *    adapter by namespace, so an adapter declaring `namespace = 'solana'` while
 *    listing `eip155:4663` would be unreachable for that chain: it would count
 *    as served at boot and then fail `CHAIN_UNSUPPORTED` at the call. Stated
 *    here because the EVM adapter is written against this contract.
 */
@Injectable()
export class ChainAdapterRegistry {
  private readonly byNamespace = new Map<ChainNamespace, ChainAdapter>();
  /** The intersection of `ENABLED_CHAINS` and what the adapters serve — see the class comment. */
  private readonly byChain = new Map<ChainId, ChainAdapter>();

  constructor(
    @Inject(CHAIN_ADAPTERS) adapters: readonly ChainAdapter[],
    @Inject(ENABLED_CHAINS) enabled: readonly ChainId[],
  ) {
    for (const adapter of adapters) {
      if (this.byNamespace.has(adapter.namespace)) {
        throw ChainErrors.duplicateAdapterNamespace({ namespace: adapter.namespace });
      }

      // Invariant 3. Checked per chain rather than per adapter because a mixed
      // list is the plausible mistake, not a wholly foreign one.
      for (const chainId of adapter.supportedChains) {
        if (namespaceOf(chainId) !== adapter.namespace) {
          throw ChainErrors.namespaceMismatch({ expected: adapter.namespace, actual: chainId });
        }
      }

      this.byNamespace.set(adapter.namespace, adapter);
    }

    // Invariant 1.
    const served = adapters.flatMap((adapter) => [...adapter.supportedChains]);
    const unserved = enabled.filter((chainId) => !served.includes(chainId));
    if (unserved.length > 0) {
      throw ChainErrors.enabledChainsInvalid({
        variable: ENABLED_CHAINS_ENV,
        value: unserved.join(','),
        accepted: `a chain some registered adapter serves — currently: ${served.join(', ')}`,
      });
    }

    // Invariant 2. Every enabled chain is served (invariant 1) and every served
    // chain is in its adapter's namespace (invariant 3), so this loop maps the
    // enabled list exactly — in the operator's order, which is the order a `402`
    // then advertises them in.
    for (const chainId of enabled) {
      const adapter = this.byNamespace.get(namespaceOf(chainId) as ChainNamespace);
      if (adapter) {
        this.byChain.set(chainId, adapter);
      }
    }
  }

  resolve(chainId: ChainId): ChainAdapter {
    // Parsed first, so a malformed id is `CHAIN_INVALID_CHAIN_ID` rather than
    // "unsupported" — the caller's mistake, named as itself.
    parseChainId(chainId);

    const adapter = this.byChain.get(chainId);
    if (!adapter) {
      throw ChainErrors.unsupportedChain({ chainId });
    }

    return adapter;
  }

  /** Every chain a `402` may advertise, in `ENABLED_CHAINS` order. */
  enabledChains(): readonly ChainId[] {
    return [...this.byChain.keys()];
  }
}
