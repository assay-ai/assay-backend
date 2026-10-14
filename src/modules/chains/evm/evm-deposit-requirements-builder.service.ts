import { Injectable, Optional } from '@nestjs/common';

import { readRequiredExtra } from '@modules/payment/domain/deposit-wire';
import {
  DepositRequirementsBuilderPort,
  DepositRequirementsInput,
  Eip155DepositRequirements,
} from '@modules/payment/ports/deposit-requirements.port';

import { ChainDoor } from '../ports/chain-state-gate.port';
import { EvmChainStateService } from './chain-state/evm-chain-state.service';
import { EVM_DEPOSIT_METHOD } from './evm.constants';

/**
 * `eip155`'s `POST /deposits` requirements — the second member of the
 * `DepositRequirements` union.
 *
 * ## Why this class exists at all, rather than the Solana builder being enough
 *
 * `DEPOSIT_REQUIREMENTS_BUILDER` was bound `useExisting: SolanaDepositRequirementsBuilder`,
 * unconditionally, so a deposit on `eip155:46630` was handed to a builder that
 * reads `extra.feePayer`, reads `extra.memo` and fetches a **Solana blockhash**.
 * The EVM adapter's requirements carry none of those three, so the first two
 * reads would have answered `502 PAYMENT_DEPOSIT_REQUIREMENTS_INCOMPLETE` —
 * blaming the facilitator for a field no EVM facilitator has ever had — and if
 * they had somehow passed, the response would have told the browser to build an
 * SPL transfer to an SPL address on a chain with neither.
 *
 * ## Nothing here is derived; it is all restated from the adapter
 *
 * `EvmChainAdapter.buildPaymentRequirements` already decided every value below
 * and put it in `PaymentRequirements.extra` — the contract, the spender, the
 * buyer and the method. This builder re-reads them rather than re-deriving
 * them from `EVM_DEPLOYMENTS`, so there is exactly one place that decides which
 * contract a buyer is told to call. A second derivation here would be a second
 * copy of the fact, which is the shape the defect this file ships alongside was
 * (`payment/domain/deposit-asset.ts`).
 *
 * `readRequiredExtra` refuses a missing or non-string field with `502
 * PAYMENT_DEPOSIT_REQUIREMENTS_INCOMPLETE`, the same as the Solana builder and
 * for a sharper reason: a `contract` that cast to the string `"undefined"`
 * would be rendered to a buyer as the address to approve.
 *
 * ## No RPC, no clock, no relayer
 *
 * Unlike its Solana counterpart this builder reads nothing from a chain. An EVM
 * transaction's lifetime is the wallet's nonce and gas price, so there is no
 * blockhash to fetch and nothing to expire; the intent's own `expiresAt` is the
 * only clock. The class is therefore pure, which is why it takes no
 * constructor argument at all — and deliberately holds no relayer: this path
 * describes a transaction the **buyer** sends.
 */
@Injectable()
export class EvmDepositRequirementsBuilder implements DepositRequirementsBuilderPort {
  /**
   * The pause/blocklist gate (D-19): `depositFor` is paused on every Config,
   * and since the dispute upgrade refuses a blocked buyer. No RPC unless the
   * cache says the deposit would be refused.
   */
  constructor(@Optional() private readonly chainState: EvmChainStateService | null = null) {}

  async build({
    chainId,
    requirements,
    decimals,
  }: DepositRequirementsInput): Promise<Eip155DepositRequirements> {
    const contract = readRequiredExtra(requirements, 'contract');
    const spender = readRequiredExtra(requirements, 'spender');
    const buyer = readRequiredExtra(requirements, 'buyer');
    await this.chainState?.assertActive(ChainDoor.DEPOSIT, [
      { role: 'BUYER', account: `${chainId}:${buyer}` },
    ]);

    return {
      namespace: 'eip155',
      chainId,
      contract,
      method: EVM_DEPOSIT_METHOD,
      spender,
      buyer,
      asset: requirements.asset,
      amount: requirements.amount,
      decimals,
      // A literal, not a copy of `extra.plainTransferCreditsNobody`: the type
      // says `true` and the day the adapter stops setting it this response must
      // still refuse to describe a transfer destination.
      plainTransferCreditsNobody: true,
    };
  }
}
