import { X402InvalidReason, X402_INVALID_REASON } from '../../facilitator.wire';
import { decodeSetComputeUnitLimit, decodeSetComputeUnitPrice } from '../compute-budget-codec';
import {
  MAX_COMPUTE_UNIT_LIMIT,
  MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
} from '../facilitator-policy.constants';
import { ResolvedSvmInstruction } from '../svm-instruction.types';

/**
 * Rule 3 — compute budget caps. Fee-payer drain via priority fees is defended
 * by a capped compute unit price plus Kora policy — this is our half of that
 * defence, and Kora's `max_allowed_lamports` (`kora/kora.toml`) is the second layer
 * beneath it, not a substitute for it: Kora only sees the transaction after we
 * have already decided to sign it.
 *
 * Reads `instructions[0]` and `[1]` positionally rather than searching for
 * Compute Budget instructions — layout (rule 2) is what fixes those positions,
 * and this rule is independently testable precisely because it does not
 * re-derive that guarantee; a caller that skips rule 2 gets a decode failure
 * here instead of a silent pass.
 */
export function checkComputeBudget(
  instructions: readonly ResolvedSvmInstruction[],
): X402InvalidReason | null {
  const limit = instructions[0] ? decodeSetComputeUnitLimit(instructions[0].data) : null;
  const price = instructions[1] ? decodeSetComputeUnitPrice(instructions[1].data) : null;

  if (limit === null || price === null) {
    return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_COMPUTE_BUDGET;
  }

  if (limit <= 0 || limit > MAX_COMPUTE_UNIT_LIMIT) {
    return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_COMPUTE_BUDGET;
  }

  if (price > MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS) {
    return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_COMPUTE_BUDGET;
  }

  return null;
}
