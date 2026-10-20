import {
  EscrowBalanceReaderPort,
  EscrowChainBalance,
} from '@modules/ledger/ports/escrow-balance-reader.port';

import { AccountId, AssetId } from '../ports/caip.types';
import { groupByNamespace, implementationFor } from './namespace-dispatch';

/**
 * `EscrowBalanceReaderPort` over more than one namespace.
 *
 * The port is keyed on a CAIP-10 account, so every method already carries the
 * chain it is about and the dispatch needs nothing the caller does not already
 * hand over. `EscrowSpendGateService`, `EscrowAccountService`, `DepositService`,
 * `ReconciliationService`, `DepositFinalityService` and `McpToolCallService` all
 * hold this port and none of them learns that there are two chains.
 *
 * ## `readMany` splits, and the split is not cosmetic
 *
 * `ReconciliationService` hands this the union of every buyer account it is
 * reconciling. With one chain that union is homogeneous; with two it is not, and
 * asking a Solana RPC about an `0x` address answers "no account" — which the
 * reconciler would read as a buyer whose escrow has been closed.
 *
 * ## No cache here either
 *
 * The Solana implementation carries its own two-tier fresh/stale cache and the
 * EVM one deliberately does not (`evm-escrow-balance-reader.service.ts` argues
 * it). This object adds nothing on top: a cache in front of a multiplexer would
 * be a third staleness policy, disagreeing with the one below it, and the
 * failure would be a spend decision made against a reading neither
 * implementation would have served.
 */
export class NamespaceEscrowBalanceReader implements EscrowBalanceReaderPort {
  constructor(private readonly byNamespace: ReadonlyMap<string, EscrowBalanceReaderPort>) {}

  async read(account: AccountId, asset: AssetId): Promise<EscrowChainBalance | null> {
    return this.readerFor(account).read(account, asset);
  }

  async readMany(
    accounts: readonly AccountId[],
    asset: AssetId,
  ): Promise<ReadonlyMap<AccountId, EscrowChainBalance | null>> {
    const merged = new Map<AccountId, EscrowChainBalance | null>();

    // Sequential, not `Promise.all`. `DepositFinalityWatcher.onModuleInit`
    // taught this codebase what an unsettled `Promise.all` costs at boot, and
    // there is no latency budget here that two round trips in series would blow.
    for (const [namespace, subset] of groupByNamespace(accounts, this.byNamespace)) {
      const partial = await this.byNamespace.get(namespace)!.readMany(subset, asset);
      for (const [key, value] of partial) {
        merged.set(key, value);
      }
    }

    return merged;
  }

  async escrowAddresses(
    account: AccountId,
    asset: AssetId,
  ): Promise<{ readonly escrowPda: AccountId; readonly escrowTokenAccount: AccountId }> {
    return this.readerFor(account).escrowAddresses(account, asset);
  }

  private readerFor(account: AccountId): EscrowBalanceReaderPort {
    return implementationFor(this.byNamespace, account);
  }
}
