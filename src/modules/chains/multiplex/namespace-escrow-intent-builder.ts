import {
  EscrowIntentBuilderPort,
  EscrowIntentRequest,
} from '@modules/settlement/ports/escrow-intent-builder.port';

import { ChainErrors } from '../errors/chains.errors';
import { AccountId, AssetId, ChainId, namespaceOf } from '../ports/caip.types';
import { implementationFor } from './namespace-dispatch';

/**
 * `EscrowIntentBuilderPort` over more than one namespace.
 *
 * Two of its three methods are keyed on a CAIP-10 account and dispatch on it.
 * The third — `withdrawDelaySeconds` — took **no argument**, which was an
 * answerable question while one chain existed and stopped being one here: Solana
 * reads `Config.withdraw_delay_seconds` off the chain, where an admin
 * `update_config` can move it inside `MIN/MAX_WITHDRAW_DELAY_SECONDS`, and EVM
 * has a compile-time `WITHDRAW_DELAY_SECONDS = 3600` in `Constants.sol` with no
 * getter at all. Answering with whichever implementation happened to be first in
 * the map would put one chain's countdown on the other chain's screen.
 *
 * So the port's method now takes the chain. That is a change under
 * `src/modules/` outside `chains/`, and it is made rather than worked around
 * because the alternative is a runtime throw on a method whose signature
 * promises an answer: taking the parameter makes the compiler find every
 * caller, and there is exactly one (`EscrowAccountService.get`, which already
 * holds the account).
 */
export class NamespaceEscrowIntentBuilder implements EscrowIntentBuilderPort {
  constructor(private readonly byNamespace: ReadonlyMap<string, EscrowIntentBuilderPort>) {}

  async escrowAsset(
    account: AccountId,
  ): Promise<{ readonly asset: AssetId; readonly decimals: number }> {
    return implementationFor(this.byNamespace, account).escrowAsset(account);
  }

  async withdrawDelaySeconds(chainId: ChainId): Promise<number> {
    const builder = this.byNamespace.get(namespaceOf(chainId));
    if (!builder) {
      throw ChainErrors.unsupportedChain({ chainId });
    }
    return builder.withdrawDelaySeconds(chainId);
  }

  async buildIntent(request: EscrowIntentRequest) {
    return implementationFor(this.byNamespace, request.account).buildIntent(request);
  }
}
