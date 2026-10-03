import { ChainErrors } from '../errors/chains.errors';
import { AccountId, AssetId, ChainId, chainIdOf, namespaceOf } from '../ports/caip.types';

/**
 * The two operations every namespace multiplexer performs.
 *
 * Four ports now dispatch on a CAIP-2 namespace, and the interesting part of
 * each is its own port's shape rather than the lookup. Sharing the lookup means
 * a namespace nobody wired up produces the same error from all four, and it
 * means the **grouping** — which is where the real bug was — has one
 * implementation to get right.
 */

/**
 * The implementation serving this identifier, or `CHAIN_UNSUPPORTED` naming the
 * chain.
 *
 * Widened from `AccountId` to any CAIP identifier: `VaultPort` is keyed
 * on a CAIP-19 **asset**, not on an account, and `namespaceOf` has always
 * accepted all three. A second lookup for the asset-keyed port would be a
 * second place for the grouping bug this function exists to have exactly one of.
 */
export function implementationFor<T>(
  byNamespace: ReadonlyMap<string, T>,
  id: ChainId | AccountId | AssetId,
): T {
  const implementation = byNamespace.get(namespaceOf(id));
  if (!implementation) {
    throw ChainErrors.unsupportedChain({ chainId: chainIdOf(id) });
  }
  return implementation;
}

/**
 * A batch, split into one group per namespace, **in first-seen order**.
 *
 * Every unknown namespace is refused **before** the first group is returned, so
 * a mixed batch containing one unserved account costs no RPC call at all. A
 * loop that read the first group and then threw would have spent a round trip
 * on a batch that was never going to be answered — and, worse, would have left
 * the caller unable to tell a partial answer from a complete one.
 *
 * Order matters to no current caller, and is stable anyway: a map whose group
 * order depended on hashing would make a failing test's output move between
 * runs.
 */
export function groupByNamespace<T>(
  accounts: readonly AccountId[],
  byNamespace: ReadonlyMap<string, T>,
): ReadonlyMap<string, AccountId[]> {
  const grouped = new Map<string, AccountId[]>();

  for (const account of accounts) {
    const namespace = namespaceOf(account);
    if (!byNamespace.has(namespace)) {
      throw ChainErrors.unsupportedChain({ chainId: chainIdOf(account) });
    }

    const group = grouped.get(namespace);
    if (group) {
      group.push(account);
    } else {
      grouped.set(namespace, [account]);
    }
  }

  return grouped;
}
