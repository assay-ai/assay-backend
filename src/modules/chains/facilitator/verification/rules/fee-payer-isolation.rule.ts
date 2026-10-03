import { Address } from '@solana/kit';

import { X402InvalidReason, X402_INVALID_REASON } from '../../facilitator.wire';
import { ResolvedSvmInstruction } from '../svm-instruction.types';

/**
 * Rule 1 — fee payer isolation, the most important of the six
 * (it "must not appear in any instruction's accounts, nor be the authority,
 * source or delegate").
 *
 * A single "does this address appear anywhere" scan is a deliberately coarser
 * check than the scheme's three named roles (authority/source/delegate) —
 * coarser is safe here because every one of those roles is just an account in
 * `ix.accounts`, so refusing the address in *any* slot, regardless of which
 * positional meaning that slot has, is a superset of the rule and cannot admit
 * a case the narrower check would have caught.
 *
 * This function trusts that `instructions` already has every account
 * lookup-table reference resolved to a real address — see
 * `decode-svm-payload.ts`. Given only the compiled instruction (a lookup-table
 * index instead of an address), this scan would find nothing and wrongly pass
 * a transaction that hides the fee payer behind an ALT slot; resolving lookups
 * is what closes that bypass, not this rule.
 */
export function checkFeePayerIsolation(
  instructions: readonly ResolvedSvmInstruction[],
  feePayer: Address,
): X402InvalidReason | null {
  for (const instruction of instructions) {
    if (instruction.accounts.includes(feePayer)) {
      return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_FEE_PAYER;
    }
  }
  return null;
}
