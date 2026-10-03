import {
  VerifierRegistryEntry,
  VerifierRegistryPort,
} from '@modules/verification/signing/ports/verifier-registry.port';

import { ChainErrors } from '../errors/chains.errors';
import { ChainId, namespaceOf } from '../ports/caip.types';

/**
 * `VerifierRegistryPort` over more than one chain.
 *
 * The first of the namespace multiplexers: an object that implements a port and
 * dispatches on the **CAIP-2 namespace** of the identifier it was handed, built
 * on the same shape as `ChainAdapterRegistry`. The call sites —
 * `VerifierKeyDirectory`, `OperatorReferenceService` — do not change and do not
 * learn that there are two chains.
 *
 * ## Why the namespace and not the whole chain id
 *
 * One `SolanaVerifierRegistryService` serves whichever cluster `SOLANA_RPC_URL`
 * points at, and one `EvmVerifierRegistryService` serves every eip155 chain in
 * `EVM_DEPLOYMENTS`. Keying the table on the full chain id would mean a row per
 * cluster, all pointing at the same instance, and a new chain would be a table
 * edit in two places instead of one. The narrower check — "does this
 * implementation serve this exact chain" — is the implementation's own, and
 * both of them make it.
 *
 * ## An unknown namespace throws
 *
 * It does not fall through to a default implementation, and it does not return
 * `null`. `null` from `lookup` means *this key was never enrolled* — a
 * deployment misconfiguration an operator is expected to fix by enrolling a key
 * — and answering it for a chain nobody wired up would send them to the admin
 * Ledger to solve a problem that lives in a provider list.
 */
export class ChainVerifierRegistry implements VerifierRegistryPort {
  constructor(private readonly byNamespace: ReadonlyMap<string, VerifierRegistryPort>) {}

  addressOf(chainId: ChainId, publicKey: Uint8Array): string {
    return this.registryFor(chainId).addressOf(chainId, publicKey);
  }

  async lookup(chainId: ChainId, publicKey: Uint8Array): Promise<VerifierRegistryEntry | null> {
    return this.registryFor(chainId).lookup(chainId, publicKey);
  }

  private registryFor(chainId: ChainId): VerifierRegistryPort {
    const registry = this.byNamespace.get(namespaceOf(chainId));
    if (!registry) {
      throw ChainErrors.unsupportedChain({ chainId });
    }
    return registry;
  }
}
