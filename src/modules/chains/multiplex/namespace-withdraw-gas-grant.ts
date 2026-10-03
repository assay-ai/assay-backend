import {
  GasGrantOutcome,
  WithdrawGasGrantPort,
} from '@modules/settlement/ports/withdraw-gas-grant.port';

import { AccountId } from '../ports/caip.types';
import { implementationFor } from './namespace-dispatch';

/**
 * `WithdrawGasGrantPort` over more than one namespace.
 *
 * The fifth multiplexer, and the same shape as the other four: dispatch on the
 * account's CAIP-2 namespace through {@link implementationFor}, so a namespace
 * nobody wired up produces `CHAIN_UNSUPPORTED` naming the chain rather than
 * being answered by whichever implementation happened to be first in the map.
 *
 * **Solana has an entry, and the entry is the point.** The obvious shape here
 * is a map containing only `eip155` and a `?? null` for a miss — "no
 * implementation means no grant". That reads correctly and is wrong in a way no
 * test would show: it makes an unserved namespace and a namespace that
 * deliberately has no grant produce the identical silent `null`, so the day
 * somebody adds a third chain and forgets to wire it, every withdrawal on it
 * quietly reports "this chain has no gas grant" instead of failing loudly.
 * {@link NoWithdrawGasGrant} makes Solana's answer a decision somebody wrote
 * down, and leaves the miss loud.
 */
export class NamespaceWithdrawGasGrant implements WithdrawGasGrantPort {
  constructor(private readonly byNamespace: ReadonlyMap<string, WithdrawGasGrantPort>) {}

  async grantWithdrawGas(
    organizationId: string,
    account: AccountId,
  ): Promise<GasGrantOutcome | null> {
    return implementationFor(this.byNamespace, account).grantWithdrawGas(organizationId, account);
  }
}

/**
 * A namespace where the question does not arise.
 *
 * Solana's `withdraw` is signed and paid for by the buyer out of the SOL that
 * already sits in the account signing it, so there has never been a buyer
 * stranded by holding tokens and no native asset — which is the entire problem
 * the gas grant exists for. This is not a stub awaiting a Solana grant: there is nothing
 * to implement.
 */
export class NoWithdrawGasGrant implements WithdrawGasGrantPort {
  async grantWithdrawGas(): Promise<null> {
    return null;
  }
}
