/**
 * The semantic stage's vocabulary.
 *
 * Stage 4 is the only stage that costs money to run and the only one that
 * cannot be re-run from the receipt alone — a model is not a pure function of
 * its prompt unless the *model* is also pinned. Everything in this file exists
 * to make a judgement re-derivable, which is the precondition for it ever
 * reaching a provider's stake:
 *
 * ```text
 * SemanticJudgement ── outcome ─┬─ NOT_SAMPLED  the budget did not buy a look
 *                               ├─ UNAVAILABLE  we tried and could not judge
 *                               └─ JUDGED       scores + a sealed context
 *                                                 └── modelId, promptVersion,
 *                                                     promptHash, temperature
 * ```
 *
 * The judgement is a **value**, produced outside the pure engine and handed to
 * it. `engine.ts` takes no clock, no socket and no repository, and a model call
 * is all three; more importantly, a call disputed months later has to
 * re-evaluate to the same verdict from its *stored* judgement rather than by
 * asking a model that has since changed. Recording the judgement and replaying
 * it is the only version of that which is actually true.
 */

import { SamplingDecision } from './sampling';

/**
 * The facts that make a verdict re-derivable. Only {@link sealSemanticContext}
 * may produce one, and it refuses every incomplete draft.
 */
export interface SemanticContext {
  /**
   * The exact model snapshot, e.g. `claude-haiku-4-5-20251001`. Never an alias.
   *
   * A floating id is the failure mode with no audit trail: the model changes
   * under a name that did not, every verdict in the catalogue shifts, and no
   * policy version, shadow comparison or deploy records it happening.
   */
  readonly modelId: string;
  /** Which rendering of the prompt produced this judgement. */
  readonly promptVersion: number;
  /** sha256 of the rendered prompt — proof of what was actually asked. */
  readonly promptHash: string;
  /** Pinned at 0. Necessary for reproducibility, and not sufficient alone. */
  readonly temperature: 0;
  /** The truncation bound in force, which changes what the model saw. */
  readonly maxInputChars: number;
}

/** A draft of the above, as it arrives from a model client. Every field suspect. */
export interface SemanticContextDraft {
  readonly modelId?: string | null;
  readonly promptVersion?: number | null;
  readonly promptHash?: string | null;
  readonly temperature?: number | null;
  readonly maxInputChars?: number | null;
}

/**
 * What the model returns, `0..1` on each axis.
 *
 * `requestInScope` is the axis that is not a score, and it is the one that
 * decides *who was wrong*. A well-formed answer that does not address the
 * request is a provider failure; the same answer to a request the tool was
 * never meant to serve is a **product** failure, and charging a provider for it
 * is the false positive `MISAPPLIED` exists to prevent.
 */
export interface SemanticScores {
  readonly relevance: number;
  readonly completeness: number;
  readonly coherence: number;
  /** Was the request itself something this tool is meant to answer? */
  readonly requestInScope: boolean;
  /** The model's one sentence. Shown on the receipt under a failed relevance row. */
  readonly reason: string | null;
}

export enum SemanticOutcome {
  /** The model judged the response. `scores` and `context` are both present. */
  JUDGED = 'JUDGED',
  /** The budget-derived draw did not select this call. Nothing was spent. */
  NOT_SAMPLED = 'NOT_SAMPLED',
  /**
   * Selected, and no usable judgement came back — timeout, transport failure,
   * an unparseable body, or a judgement refused as unreproducible.
   *
   * Credits the provider. Our own unavailability is never a provider's loss.
   */
  UNAVAILABLE = 'UNAVAILABLE',
}

/**
 * One call's semantic evidence, sampling decision included.
 *
 * The sampling decision travels even when the answer is "not sampled", because
 * *the rate itself is the published fact*: a receipt has to be able to
 * say "not checked — 1 in 125 calls at this price" rather than staying silent,
 * which reads as a check that passed.
 */
export interface SemanticJudgement {
  readonly outcome: SemanticOutcome;
  readonly sampling: SamplingDecision;
  readonly scores: SemanticScores | null;
  readonly context: SemanticContext | null;
  /** What this judgement actually cost. Zero unless a model was called. */
  readonly costUsd: number;
  /** Stable code for why nothing was judged, e.g. `semantic_timeout`. */
  readonly unavailableReason: string | null;
}

/**
 * The policy's semantic block.
 *
 * `enabled` alone was the original placeholder (`DeclaredStage`); the
 * thresholds came later. Only `minRelevance` has a default, 0.7 —
 * the other two axes gate only when a policy author asks for them, because a
 * threshold nobody chose is a threshold nobody can defend in a dispute.
 */
export interface SemanticPolicy {
  readonly enabled: boolean;
  /** Below this, relevance fails. Defaults to {@link DEFAULT_MIN_RELEVANCE}. */
  readonly minRelevance?: number;
  readonly minCompleteness?: number;
  readonly minCoherence?: number;
}

export const DEFAULT_MIN_RELEVANCE = 0.7;
