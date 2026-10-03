/**
 * Verification policies — one per tool, versioned.
 *
 * A policy is data for the same reason a mapping is: policy changes are **the
 * highest-risk deploys in the system**, because a
 * bad rule can slash dozens of honest providers before anyone notices. Data can
 * be versioned, diffed, shadowed and reverted without a deploy; code cannot.
 *
 * Three safety properties are structural here rather than procedural:
 *
 * 1. **`mode` defaults to nothing.** It is required, so a policy cannot reach
 *    production having merely forgotten to say whether it is live.
 * 2. **`SHADOW` is enforced at the verdict**, not at the call site — see
 *    `effectiveConsequence` in `./verdict.ts`.
 * 3. **The empty-result disposition defaults to passing.** A policy author who
 *    says nothing about empty results gets the safe answer, not a strike.
 */

import { JsonSchema } from '@modules/tool/domain/mapping/schema-validator';
import { RuleCondition, VerificationRule } from './rules/rule.types';
import { SemanticPolicy } from './semantic.types';

export enum PolicyMode {
  /** Verdicts are computed and recorded, and have no economic effect. */
  SHADOW = 'SHADOW',
  ACTIVE = 'ACTIVE',
}

/**
 * What to do with an empty result set.
 *
 * The `MIN_ARRAY_LENGTH ≥ 1` rule is the single most likely source of false
 * positives in the whole engine, because "no results" and "broken" produce the
 * identical response body. This block is how a tool says which one its empties
 * are, and the default — when the block is absent entirely — is the one that
 * cannot take money from someone who did nothing wrong.
 */
export interface EmptyResultPolicy {
  /**
   * What the verdict is when nothing corroborates the emptiness.
   *
   * Defaults to `PASS_UNVERIFIED`. `FAIL` is for tools where an empty answer is
   * provably impossible — a price lookup for an asset that exists, a block
   * fetch by height. On a search tool it is almost always wrong.
   */
  readonly whenUncorroborated?: EmptyResultDisposition;
  /**
   * Evidence *inside the provider's own response* that the emptiness is real:
   * `$.totalResults == 0`, `$.status == "no_results"`, a `nextPageToken` that
   * is absent.
   *
   * Weak evidence — the provider is vouching for itself — and deliberately so.
   * It is the only corroboration available before cross-check exists,
   * it costs nothing, and it decides between two statuses that **both pay the
   * provider**. Nothing rides on it except which word the receipt prints and
   * which metric moves. It is never used to fail anyone.
   */
  readonly evidence?: readonly RuleCondition[];
}

export enum EmptyResultDisposition {
  /** Credit the provider, record that no second source confirmed it. */
  PASS_UNVERIFIED = 'PASS_UNVERIFIED',
  /** An empty answer is impossible for this tool. Strike. */
  FAIL = 'FAIL',
}

export interface VerificationPolicy {
  readonly id: string;
  readonly toolId: string;
  readonly version: number;

  /**
   * The shape the response must have.
   *
   * Optional, and when absent the engine uses the tool's own `outputSchema` —
   * which is the right default and should be the usual case. A policy carrying
   * its own copy of the schema is a second source of truth for the tool
   * contract, and the two drift silently: the mapping keeps satisfying
   * `outputSchema` while verification fails against a stale copy, and the
   * provider is the one who pays for the divergence. Set it only to *narrow*
   * the contract for verification purposes.
   */
  readonly schema?: JsonSchema;

  readonly rules: readonly VerificationRule[];

  /** Absent means an empty result passes, unconfirmed. See {@link EmptyResultPolicy}. */
  readonly emptyResult?: EmptyResultPolicy;

  /**
   * Aggregate score below this fails the deterministic stage.
   *
   * Scored over the rules that **applied**, so inapplicable rules do not eat
   * the margin between the score and the threshold.
   */
  readonly passThreshold: number;

  readonly mode: PolicyMode;

  /**
   * Declared applicable but unimplemented stages.
   *
   * Present so a policy can state that cross-check or semantic
   * judgement is *meaningful for this tool* before either exists. The
   * engine records such a stage as `NOT_IMPLEMENTED` rather than
   * `NOT_APPLICABLE`, which is the difference between "we have not built it"
   * and "there is nothing here to build". A policy that declares neither gets
   * `NOT_APPLICABLE` for both, which is the honest reading for a tool where
   * cross-check has no stable projection to compare on.
   */
  readonly crossCheck?: DeclaredStage;
  /**
   * The relevance judgement's thresholds.
   *
   * Was originally a bare `DeclaredStage` — "this tool has something worth
   * judging" and nothing more. It now carries the bars themselves, and only
   * `minRelevance` has a default. See {@link SemanticPolicy}.
   */
  readonly semantic?: SemanticPolicy;
}

/**
 * A stage the policy declares meaningful for this tool.
 *
 * Empty of configuration on purpose — cross-check will fill it in once built.
 * What it carries today is its own existence, which is exactly the
 * applicability fact a policy must declare. The semantic stage outgrew it; see
 * {@link SemanticPolicy}.
 */
export interface DeclaredStage {
  readonly enabled: boolean;
}
