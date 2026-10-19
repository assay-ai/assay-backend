import { AccountId, AssetId, ChainId, ChainNamespace, namespaceOf } from '../ports/caip.types';
import { Money } from '../ports/money.types';
import { VaultPort } from '../ports/vault.port';
import { implementationFor } from './namespace-dispatch';

/**
 * `VaultPort` keyed by namespace.
 *
 * Only `eip155` has a vault — the escrow contract — so today the map holds at
 * most that one entry, and an asset on any other namespace is
 * `CHAIN_UNSUPPORTED` rather than being answered by whoever happened to be
 * bound. Handing an `eip155` reader a Solana asset (or the other way round)
 * would not fail cleanly; it would read an account that belongs to somebody
 * else, which is why this is a dispatcher and not a branch inside one class.
 *
 * ## The map is built from `ENABLED_CHAINS`, not from what happens to be wired
 *
 * A chain absent from `ENABLED_CHAINS` must be absent **everywhere**.
 * {@link buildNamespaceVaultPort} is the one place that decision is made, and
 * both the module and its test go through it.
 *
 * ## Nothing here folds
 *
 * Every method takes one asset and returns one answer from one chain. There is
 * no method that visits several chains, and there must not be: a
 * `totalVaultBalance` across chains is precisely the cross-chain sum the
 * chains' independence exists to deny.
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
 * The multiplexer this deployment's enabled chains call for: the EVM vault when
 * an `eip155` chain is enabled, and nothing otherwise.
 */
export function buildNamespaceVaultPort(input: {
  readonly enabled: readonly ChainId[];
  readonly evm: VaultPort;
}): NamespaceVaultPort {
  const byNamespace = new Map<string, VaultPort>();
  if (input.enabled.some((chainId) => namespaceOf(chainId) === ChainNamespace.EIP155)) {
    byNamespace.set(ChainNamespace.EIP155, input.evm);
  }
  return new NamespaceVaultPort(byNamespace);
}
