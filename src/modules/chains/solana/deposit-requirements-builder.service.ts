import { Inject, Injectable } from '@nestjs/common';

import { readRequiredExtra } from '@modules/payment/domain/deposit-wire';
import {
  DepositRequirements,
  DepositRequirementsBuilderPort,
  DepositRequirementsInput,
} from '@modules/payment/ports/deposit-requirements.port';

import { BLOCKHASH_READER, BlockhashReaderPort } from './blockhash.port';

/**
 * Solana's `POST /deposits` requirements.
 *
 * The blockhash read lives here, in the Solana adapter's builder, rather than
 * in `DepositsController`: an RPC read does not belong in an HTTP handler, and
 * an SVM primitive is not a field of a chain-neutral controller.
 *
 * ## The blockhash is read exactly once
 *
 * `DepositService.settleDeposit` rebuilds the x402 requirements a second time
 * before calling `facilitator.verify`, and never re-reads a blockhash. So the
 * one this method fetches is the only one that ever exists for this intent —
 * which is what makes the buyer's signature verifiable at settle time.
 *
 * ## Why it imports `readRequiredExtra` from `payment/`
 *
 * `PaymentRequirements.extra` is `Record<string, unknown>` because it is
 * chain-specific by design, and `feePayer`/`memo` therefore arrive untyped.
 * `readRequiredExtra` refuses a non-string with `503
 * PAYMENT_DEPOSIT_REQUIREMENTS_INCOMPLETE` — the facilitator failed to hold up
 * its end, and nothing the caller sent could have caused it or can fix it. Cast
 * instead of checked, a missing `feePayer` becomes the string `"undefined"` in
 * a 402 response, the browser signs against it, and the failure surfaces at the
 * facilitator as an invalid payload the buyer cannot interpret.
 *
 * The import direction — `chains/solana/` reaching into `payment/domain/` — is
 * the one `SolanaBlockhashService` already had before this change, and it is
 * the right way round: the domain owns the refusal and its error code, and the
 * chain owns knowing that `extra` is where an SVM fee payer lives.
 */
@Injectable()
export class SolanaDepositRequirementsBuilder implements DepositRequirementsBuilderPort {
  constructor(@Inject(BLOCKHASH_READER) private readonly blockhash: BlockhashReaderPort) {}

  async build({
    chainId,
    requirements,
    decimals,
  }: DepositRequirementsInput): Promise<DepositRequirements> {
    // Read before the blockhash, deliberately: a missing `feePayer` is a 503
    // that does not need an RPC round trip to discover.
    const feePayer = readRequiredExtra(requirements, 'feePayer');
    const memo = readRequiredExtra(requirements, 'memo');

    const { blockhash, lastValidBlockHeight } = await this.blockhash.getLatestBlockhash();

    return {
      namespace: 'solana',
      chainId,
      payTo: requirements.payTo,
      asset: requirements.asset,
      amount: requirements.amount,
      decimals,
      feePayer,
      memo,
      blockhash,
      // `u64` — a `bigint` here, a decimal string on the wire. `JSON.stringify`
      // throws on a `bigint`, so this conversion is not cosmetic.
      lastValidBlockHeight: lastValidBlockHeight.toString(),
    };
  }
}
