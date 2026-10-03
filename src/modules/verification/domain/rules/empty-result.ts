/**
 * What an empty result set means.
 *
 * One function, used by both cheap stages, because both can discover the same
 * fact by different routes and there must not be two answers to it:
 *
 * ```text
 * schema stage         outputSchema declares `minItems: 1`, the array is []
 *                      → TOOL_MAPPING_EMPTY_COLLECTION
 * deterministic stage  a MIN_ARRAY_LENGTH rule resolves to []
 *                      → RuleOutcome.EMPTY_COLLECTION
 * ```
 *
 * `schema-validator.ts` already gives the empty case its own error code rather
 * than folding it into a generic constraint failure, and says why in its own
 * words: *"the difference between a provider with no data and a provider with
 * wrong data is the difference between `EMPTY_CONFIRMED` and a strike."* This
 * file is the other end of that sentence. Without it the schema stage would
 * turn a `minItems` violation into a `FAIL` before the deterministic stage ever
 * got to apply the tool's empty-result policy — a false positive that no policy
 * author could see coming, since they would have written the policy correctly
 * and been overruled by the layer above it.
 *
 * **Every branch here except the explicitly opted-in one credits the
 * provider.** A provider whose coverage is narrow and honest must not score
 * worse than one that pads results; that inversion is the exact opposite of
 * what the product sells.
 */

import { EmptyResultDisposition, VerificationPolicy } from '../policy.types';
import { StageInput, StageStatus } from '../stage';
import { VerdictStatus } from '../verdict';
import { conditionHolds } from './condition';

export interface EmptyResultDecision {
  readonly status: StageStatus;
  readonly code: string;
  readonly detail: string;
  readonly score: number | null;
  readonly verdict: VerdictStatus;
}

/**
 * Three outcomes, and the default is the one that cannot take money from
 * someone who did nothing wrong.
 *
 * - The tool declares an empty answer impossible (`whenUncorroborated: FAIL`)
 *   → `FAIL`. Correct for a price lookup on an asset that exists or a block
 *   fetch by height; almost always wrong for a search tool, which is why it has
 *   to be opted into.
 * - The policy names `evidence` and every condition holds → `EMPTY_CONFIRMED`.
 *   The provider is vouching for itself, which is weak — and it decides between
 *   two statuses that **both pay**, so nothing rides on it except which word the
 *   receipt prints. Cross-check is what makes it strong.
 * - Anything else, **including no `emptyResult` block at all** →
 *   `EMPTY_UNVERIFIED`.
 *
 * `detail` takes an optional `where` so the schema stage can name the pointer
 * it found the empty collection at. A nested empty collection is not literally
 * "the result set was empty", and this function deliberately treats it as
 * though it were: the two are indistinguishable without knowing which array the
 * tool considers its result set, and of the two possible mistakes, paying for a
 * response with an empty sub-array is the one that cannot cost an honest
 * provider their stake.
 */
export function decideEmptyResult(
  policy: VerificationPolicy,
  input: StageInput,
  where?: string | null,
): EmptyResultDecision {
  const at = where ? ` at ${where}` : '';

  if (policy.emptyResult?.whenUncorroborated === EmptyResultDisposition.FAIL) {
    return {
      status: StageStatus.FAILED,
      code: 'empty_result',
      detail: `The result set was empty${at} and this tool declares an empty answer impossible`,
      score: null,
      verdict: VerdictStatus.FAIL,
    };
  }

  const evidence = policy.emptyResult?.evidence;
  // An `evidence` block with zero conditions would vacuously satisfy "every
  // condition holds" and confirm nothing on no basis at all — guarded against
  // explicitly rather than relying on `Array.prototype.every`'s default on an
  // empty array.
  const confirmed =
    evidence !== undefined &&
    evidence.length > 0 &&
    evidence.every((condition) => conditionHolds(condition, input));

  return confirmed
    ? {
        status: StageStatus.PASSED,
        code: 'empty_result_confirmed',
        detail: `The empty result${at} is corroborated by evidence in the response`,
        score: 1,
        verdict: VerdictStatus.EMPTY_CONFIRMED,
      }
    : {
        status: StageStatus.PASSED,
        code: 'empty_result_unverified',
        detail: `The result set was empty${at} and nothing corroborated it`,
        score: 1,
        verdict: VerdictStatus.EMPTY_UNVERIFIED,
      };
}
