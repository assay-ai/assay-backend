import { address } from '@solana/kit';
import {
  getTransferCheckedInstructionDataDecoder,
  identifyTokenInstruction,
  TokenInstruction,
} from '@solana-program/token';

import { PaymentRequirements } from '../../../ports/x402.types';
import { X402InvalidReason, X402_INVALID_REASON } from '../../facilitator.wire';
import { TOKEN_PROGRAM_ADDRESSES } from '../facilitator-policy.constants';
import { ResolvedSvmInstruction } from '../svm-instruction.types';

/**
 * Rule 4 — transfer correctness. `requirements.payTo` is already the vault's
 * *associated token account* by the time it reaches the facilitator —
 * `SolanaChainAdapter.buildPaymentRequirements` derives it once, when the 402
 * is issued — so this rule compares the instruction's destination against it
 * directly rather than re-deriving an ATA from an owner here. Re-deriving
 * would need the SPL Token ATA program and duplicate logic that already lives,
 * correctly, on the other side of the process boundary.
 *
 * "Exactly one matching transfer" is enforced by counting every
 * `TransferChecked` in the instruction list, not just the one at the position
 * rule 2 expects — a transaction that smuggles a second transfer past a
 * Lighthouse-shaped slot check is still exactly as much of a problem.
 */
export function checkTransferCorrectness(
  instructions: readonly ResolvedSvmInstruction[],
  requirements: PaymentRequirements,
): X402InvalidReason | null {
  const transfers = instructions.filter(
    (ix) =>
      TOKEN_PROGRAM_ADDRESSES.includes(ix.programAddress) &&
      identifyTokenInstruction(ix) === TokenInstruction.TransferChecked,
  );

  if (transfers.length !== 1) {
    return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_TRANSFER;
  }

  const [, mint, destination] = transfers[0].accounts;

  if (mint !== address(requirements.asset)) {
    return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_ASSET;
  }

  if (destination !== address(requirements.payTo)) {
    return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_RECIPIENT;
  }

  const { amount } = getTransferCheckedInstructionDataDecoder().decode(transfers[0].data);
  if (amount < BigInt(requirements.amount)) {
    return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_AMOUNT;
  }

  return null;
}
