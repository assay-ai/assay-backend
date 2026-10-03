import { PaymentRequirements } from '../../../ports/x402.types';
import { X402InvalidReason, X402_INVALID_REASON } from '../../facilitator.wire';
import { MEMO_PROGRAM_ADDRESS } from '../facilitator-policy.constants';
import { ResolvedSvmInstruction } from '../svm-instruction.types';

const decoder = new TextDecoder();

/**
 * Rule 5 — memo. `extra.memo`
 * is the only thing that ties these lamports to this intent on-chain, so an
 * absent or mismatched memo is exactly as fatal as a wrong amount. Two memo
 * instructions is refused rather than "matches if any one does" — an attacker
 * who can attach an unrelated second memo could otherwise use the same
 * transaction to *look* bound to two different intents depending on which
 * instruction a careless reader checks.
 */
export function checkMemo(
  instructions: readonly ResolvedSvmInstruction[],
  requirements: PaymentRequirements,
): X402InvalidReason | null {
  const expected = requirements.extra?.memo;
  if (typeof expected !== 'string') {
    return null;
  }

  const memos = instructions.filter((ix) => ix.programAddress === MEMO_PROGRAM_ADDRESS);
  if (memos.length !== 1) {
    return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_MEMO;
  }

  if (decoder.decode(memos[0].data) !== expected) {
    return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_MEMO;
  }

  return null;
}
