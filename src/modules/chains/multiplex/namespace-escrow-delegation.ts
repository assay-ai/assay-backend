import { UnsignedChainTransaction } from '@modules/chains/ports/unsigned-chain-transaction';
import {
  DelegationTerms,
  EscrowDelegation,
  EscrowDelegationPort,
} from '@modules/settlement/ports/escrow-delegation.port';

import { AccountId } from '../ports/caip.types';
import { implementationFor } from './namespace-dispatch';

/**
 * Agent payment delegation, dispatched by the payer's namespace. `eip155` is
 * the only entry: the Solana escrow has no delegation, so a Solana account is
 * refused `CHAIN_UNSUPPORTED` here rather than by a stub that agreed the
 * operation made sense.
 */
export class NamespaceEscrowDelegation implements EscrowDelegationPort {
  constructor(private readonly byNamespace: ReadonlyMap<string, EscrowDelegationPort>) {}

  authorizeIntent(account: AccountId, terms: DelegationTerms): Promise<UnsignedChainTransaction> {
    return implementationFor(this.byNamespace, account).authorizeIntent(account, terms);
  }

  revokeIntent(account: AccountId, delegate: AccountId): Promise<UnsignedChainTransaction> {
    return implementationFor(this.byNamespace, account).revokeIntent(account, delegate);
  }

  list(account: AccountId): Promise<readonly EscrowDelegation[]> {
    return implementationFor(this.byNamespace, account).list(account);
  }
}
