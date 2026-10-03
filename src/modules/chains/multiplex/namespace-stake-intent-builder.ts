import {
  StakeAsset,
  StakeIntentBuilderPort,
  StakeIntentPreflight,
  StakeIntentRequest,
} from '@modules/provider/ports/stake-intent-builder.port';

import { AccountId, ChainId } from '../ports/caip.types';
import { Money } from '../ports/money.types';
import { UnsignedChainTransaction } from '../ports/unsigned-chain-transaction';
import { implementationFor } from './namespace-dispatch';

/**
 * `StakeIntentBuilderPort` over more than one namespace.
 *
 * `STAKE_INTENT_BUILDER` was bound `useExisting: SolanaStakeIntentBuilder` for
 * every chain — the last of the chain ports to be, after `ESCROW_OPENER`,
 * `VAULT_PORT` and `ESCROW_INTENT_BUILDER` got multiplexers — so an
 * eip155 provider could not stake through the product at all. Two methods are
 * keyed on a chain and three on an account; every one dispatches on its own
 * argument, never on a configured default.
 */
export class NamespaceStakeIntentBuilder implements StakeIntentBuilderPort {
  constructor(private readonly byNamespace: ReadonlyMap<string, StakeIntentBuilderPort>) {}

  async stakeAsset(chain: ChainId): Promise<StakeAsset> {
    return implementationFor(this.byNamespace, chain).stakeAsset(chain);
  }

  needsOpenStake(chain: ChainId): boolean {
    return implementationFor(this.byNamespace, chain).needsOpenStake(chain);
  }

  async preflight(request: StakeIntentRequest): Promise<StakeIntentPreflight> {
    return implementationFor(this.byNamespace, request.account).preflight(request);
  }

  async confirmedDeposit(signature: string, account: AccountId): Promise<Money | null> {
    return implementationFor(this.byNamespace, account).confirmedDeposit(signature, account);
  }

  async buildIntent(
    request: StakeIntentRequest,
  ): Promise<{ transaction: UnsignedChainTransaction; preflight: StakeIntentPreflight }> {
    return implementationFor(this.byNamespace, request.account).buildIntent(request);
  }
}
