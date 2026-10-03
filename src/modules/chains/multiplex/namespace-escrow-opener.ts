import { EscrowOpenerPort } from '@modules/payment/ports/escrow-opener.port';

import { AccountId, AssetId } from '../ports/caip.types';
import { implementationFor } from './namespace-dispatch';

/**
 * `EscrowOpenerPort` over more than one namespace.
 *
 * Dispatches on the **buyer account**, which is the only argument that carries
 * a chain: `asset` carries one too, but the two are checked against each other
 * downstream (`EvmEscrowBalanceReader.assertAsset`,
 * `SolanaEscrowOpener.open`), and picking the implementation off the asset
 * would mean a Solana asset and an EVM buyer resolved to the Solana opener and
 * failed inside it rather than at the boundary.
 *
 * This is the last of the deposit path's ports to get a second member, and its
 * absence is what `POST /deposits` on `eip155:46630` hit the moment the asset
 * gate stopped refusing it: `useExisting: SolanaEscrowOpener` handed an `0x`
 * address to a base58 decoder and answered `409 PAYMENT_ESCROW_NOT_OPEN`.
 */
export class NamespaceEscrowOpener implements EscrowOpenerPort {
  constructor(private readonly byNamespace: ReadonlyMap<string, EscrowOpenerPort>) {}

  async open(buyer: AccountId, asset: AssetId) {
    return implementationFor(this.byNamespace, buyer).open(buyer, asset);
  }
}
