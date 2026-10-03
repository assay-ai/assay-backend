import { Address } from '@solana/kit';
import { identifyTokenInstruction, TokenInstruction } from '@solana-program/token';

import { TOKEN_PROGRAM_ADDRESSES } from './facilitator-policy.constants';
import { ResolvedSvmInstruction } from './svm-instruction.types';

/**
 * `VerifyResponseBody.payer` / `SettleResponseBody.payer` — "bare chain address
 * of the payer, when it could be determined." On SVM the payer is the
 * `TransferChecked` authority: the account whose tokens actually moved, which
 * is never the fee payer once rule 1 has passed.
 *
 * Called only after `checkTransferCorrectness` has already confirmed exactly
 * one matching transfer exists, so the positional read (`accounts[3]`) is safe
 * — this function does not re-validate the instruction it reads from.
 */
export function extractPayerAddress(
  instructions: readonly ResolvedSvmInstruction[],
): Address | undefined {
  const transfer = instructions.find(
    (ix) =>
      TOKEN_PROGRAM_ADDRESSES.includes(ix.programAddress) &&
      identifyTokenInstruction(ix) === TokenInstruction.TransferChecked,
  );
  return transfer?.accounts[3];
}
