import {
  RelayedEscrowIntent,
  RelayedEscrowIntentPort,
  RelayedEscrowSubmission,
} from '@modules/settlement/ports/relayed-escrow-intent.port';

import { implementationFor } from './namespace-dispatch';

/**
 * `RelayedEscrowIntentPort` over more than one namespace.
 *
 * The map has **one entry**, `eip155`, and that is the whole point of routing
 * through it: a Solana account reaches `implementationFor`, finds nothing, and
 * is refused `CHAIN_UNSUPPORTED` naming its own chain.
 *
 * A `NoRelayedEscrowIntent` stub in the Solana slot — the shape
 * `NoWithdrawGasGrant` takes next door — would be the wrong answer here, and
 * the difference is worth stating. A gas grant that answers `UNAVAILABLE` is a
 * *correct* answer on Solana: the buyer already holds the SOL that signs their
 * own withdrawal, so there is nothing to grant and nothing is denied them. A
 * relayed submission has no such answer. Solana's buyer doors are transactions
 * the buyer signs and sends themselves; there is no meta-transaction, no
 * `authNonce`, and no EIP-712 request to carry. A stub would have to refuse
 * every call anyway, and it would refuse them one layer further in, having
 * already agreed that the operation was meaningful.
 */
export class NamespaceRelayedEscrowIntent implements RelayedEscrowIntentPort {
  constructor(private readonly byNamespace: ReadonlyMap<string, RelayedEscrowIntentPort>) {}

  async submit(intent: RelayedEscrowIntent): Promise<RelayedEscrowSubmission> {
    return implementationFor(this.byNamespace, intent.account).submit(intent);
  }
}
