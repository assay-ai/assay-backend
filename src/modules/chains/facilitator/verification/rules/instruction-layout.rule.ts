import { identifyTokenInstruction, TokenInstruction } from '@solana-program/token';

import { X402InvalidReason, X402_INVALID_REASON } from '../../facilitator.wire';
import { decodeSetComputeUnitLimit, decodeSetComputeUnitPrice } from '../compute-budget-codec';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  MAX_STATIC_INSTRUCTIONS,
  MIN_STATIC_INSTRUCTIONS,
  OPTIONAL_TRAILING_PROGRAM_ADDRESSES,
  TOKEN_PROGRAM_ADDRESSES,
} from '../facilitator-policy.constants';
import { ResolvedSvmInstruction } from '../svm-instruction.types';

/**
 * Rule 2 — instruction layout: "Compute Budget limit, Compute Budget price, `TransferChecked`,
 * plus up to three optional Lighthouse/Memo instructions. Anything else is a
 * rejection."
 *
 * A closed allowlist on *shape*, not merely on program id: a transaction that
 * puts a second `TransferChecked` where a Lighthouse assertion belongs would
 * pass a program-id-only check and move a second, unaccounted-for amount.
 * Fixed positions for the first three instructions is what makes rules 3 and 4
 * safe to assume "instruction 0 is the limit, instruction 2 is the transfer"
 * without re-deriving it themselves.
 */
export function checkInstructionLayout(
  instructions: readonly ResolvedSvmInstruction[],
): X402InvalidReason | null {
  if (
    instructions.length < MIN_STATIC_INSTRUCTIONS ||
    instructions.length > MAX_STATIC_INSTRUCTIONS
  ) {
    return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_INSTRUCTIONS;
  }

  const [limitIx, priceIx, transferIx, ...trailing] = instructions;

  if (
    limitIx.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS ||
    decodeSetComputeUnitLimit(limitIx.data) === null
  ) {
    return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_INSTRUCTIONS;
  }

  if (
    priceIx.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS ||
    decodeSetComputeUnitPrice(priceIx.data) === null
  ) {
    return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_INSTRUCTIONS;
  }

  if (
    !TOKEN_PROGRAM_ADDRESSES.includes(transferIx.programAddress) ||
    identifyTokenInstruction(transferIx) !== TokenInstruction.TransferChecked
  ) {
    return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_INSTRUCTIONS;
  }

  for (const ix of trailing) {
    if (!OPTIONAL_TRAILING_PROGRAM_ADDRESSES.includes(ix.programAddress)) {
      return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_INSTRUCTIONS;
    }
  }

  return null;
}
