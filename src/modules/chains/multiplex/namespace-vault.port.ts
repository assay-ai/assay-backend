import { AccountId, AssetId, ChainId, ChainNamespace, namespaceOf } from '../ports/caip.types';
import { Money } from '../ports/money.types';
import { VaultPort } from '../ports/vault.port';
import { implementationFor } from './namespace-dispatch';

/**
 * `VaultPort` over more than one namespace.
 *
 * ## Why this had to exist before the reconciler could run on a second chain
 *
 * `ReconciliationService.run` opens with `await this.vault.assertVaultControl(asset)`,
 * and until this file `VAULT_PORT` resolved to `SquadsVaultService` — a Squads
 * multisig PDA and an ATA, on Solana. Handing that an `eip155` asset does not
 * fail cleanly: the Solana reader base58-decodes the reference, derives a PDA
 * from it and reads **a real account belonging to somebody else**. That is the
 * measured shape of every missing multiplexer in this codebase, and it is why
 * the fix is a dispatcher rather than a branch inside the Solana class.
 *
 * ## The map is built from `ENABLED_CHAINS`, not from what happens to be wired
 *
 * A chain absent from `ENABLED_CHAINS` must be absent **everywhere**. A
 * multiplexer holding a live EVM client for a disabled chain has already opened
 * a socket nobody asked for, and — worse — would answer a question about a
 * chain this deployment does not serve. {@link buildNamespaceVaultPort} is the
 * one place that decision is made, and both the module and its test go through
 * it, so the test cannot pass against a differently-built map.
 *
 * ## Nothing here folds
 *
 * Every method takes one asset and returns one answer from one chain. There is
 * no method that visits both maps, and there must not be: a `totalVaultBalance`
 * across namespaces is precisely the cross-chain sum the chains' independence
 * exists to deny, and it would not be observable as wrong until the second chain
 * diverged.
 */
export class NamespaceVaultPort implements VaultPort {
  constructor(private readonly byNamespace: ReadonlyMap<string, VaultPort>) {}

  /** Which namespaces this deployment actually serves. Exposed so a test can see the wiring. */
  namespaces(): readonly string[] {
    return [...this.byNamespace.keys()];
  }

  async getVaultOwner(asset: AssetId): Promise<AccountId> {
    return this.vaultFor(asset).getVaultOwner(asset);
  }

  async getVaultAccount(asset: AssetId): Promise<AccountId> {
    return this.vaultFor(asset).getVaultAccount(asset);
  }

  async getVaultBalance(asset: AssetId): Promise<Money> {
    return this.vaultFor(asset).getVaultBalance(asset);
  }

  async getVaultBalanceAt(asset: AssetId): Promise<{ balance: Money; slot: bigint }> {
    return this.vaultFor(asset).getVaultBalanceAt(asset);
  }

  async assertVaultControl(asset: AssetId): Promise<void> {
    return this.vaultFor(asset).assertVaultControl(asset);
  }

  private vaultFor(asset: AssetId): VaultPort {
    return implementationFor(this.byNamespace, asset);
  }
}

/**
 * The multiplexer this deployment's enabled chains call for.
 *
 * A namespace with no enabled chain gets **no entry at all**, so an asset on it
 * is `CHAIN_UNSUPPORTED` rather than being answered by whoever happened to be
 * bound. Both implementations are still constructed by the DI graph — they are
 * ordinary providers and constructing one dials nothing — but only the enabled
 * ones are reachable through the port every domain service holds.
 */
export function buildNamespaceVaultPort(input: {
  readonly enabled: readonly ChainId[];
  readonly solana: VaultPort;
  readonly evm: VaultPort;
}): NamespaceVaultPort {
  const byNamespace = new Map<string, VaultPort>();
  const serves = (namespace: string): boolean =>
    input.enabled.some((chainId) => namespaceOf(chainId) === namespace);

  if (serves(ChainNamespace.SOLANA)) {
    byNamespace.set(ChainNamespace.SOLANA, input.solana);
  }
  if (serves(ChainNamespace.EIP155)) {
    byNamespace.set(ChainNamespace.EIP155, input.evm);
  }

  return new NamespaceVaultPort(byNamespace);
}
