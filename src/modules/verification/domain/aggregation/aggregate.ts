/**
 * The aggregator.
 *
 * Votes in, one verdict out. Pure — no clock, no store, no kill-switch read:
 * `evaluatedAt` is a parameter and the lifecycle arrives already resolved, for
 * the same reason `../engine.ts` is pure. A dispute re-runs this
 * function over the stored verifier results and the stored policy version and
 * must reach the stored verdict; a function that consulted anything live could
 * not promise that, and a slash that cannot reproduce its own evidence is not
 * defensible.
 *
 * ```text
 *  schema ─┐
 *  rules ──┤                     ┌─ tally ─┐
 *  cross ──┤─▶ declared verifiers│         │─▶ first matching clause ─▶ status
 *  semantic┤   (undeclared votes │ pass 1  │   (else `otherwise`)
 *  3rd-pty ┘    are discarded)   │ fail 2  │
 *                                └─────────┘
 * ```
 *
 * Three rules do the load-bearing work, and each one is a way of not striking
 * somebody by accident:
 *
 * 1. **The denominator is the *declared* verifier set, not the results that
 *    turned up.** A declared verifier that produced nothing is counted
 *    `UNAVAILABLE`, not omitted. Otherwise "2 of 4" is satisfied by two
 *    failures and two crashes, and a policy that reads like a quorum decides on
 *    a minority.
 * 2. **A vote from a verifier the policy does not declare is discarded.**
 *    Adding a verifier is an edit to a policy document — which is versioned,
 *    promoted and killable. If an undeclared result could swing a quorum, then
 *    anything able to construct a `VerifierResult` could strike a provider
 *    without passing any of those gates.
 * 3. **Only `PASS` and `FAIL` are votes.** `MISAPPLIED` is an opinion about the
 *    *check*, and `UNAVAILABLE`/`ABSTAIN` are silence. None of the three is
 *    evidence about the provider, so none of them may sit in the denominator
 *    that decides one.
 */

import { VerificationErrors } from '../../errors/verification.errors';
import { VERDICT_CONSEQUENCE, VerdictStatus } from '../verdict';
import {
  DecisionClause,
  DecisionPolicy,
  DecisionTrigger,
  PolicyLifecycle,
  enforces,
} from './decision-policy.types';
import { VerifierOutcome, VerifierResult, isVote } from './verifier.types';

/** The arithmetic behind a verdict, kept so a receipt can show its working. */
export interface VoteTally {
  /** Declared verifiers. The `4` in "2 of 4". */
  readonly declared: number;
  /** `PASS + FAIL` — the quorum denominator. */
  readonly votes: number;
  readonly passed: number;
  readonly failed: number;
  readonly misapplied: number;
  readonly unavailable: number;
  readonly abstained: number;
  /** `failed / votes`, or `null` when nobody voted. Never `0` on no votes. */
  readonly failedFraction: number | null;
  /**
   * Results discarded because the policy does not declare that verifier.
   *
   * Non-zero is a misconfiguration worth alerting on — some verifier is running
   * and being ignored — which is why it is counted rather than dropped.
   */
  readonly unregistered: number;
}

/** Which clause decided, for the receipt and for metrics. */
export interface DecidedBy {
  /** Index into `DecisionPolicy.clauses`, or `null` for the `otherwise` default. */
  readonly clauseIndex: number | null;
  readonly trigger: DecisionTrigger | null;
  readonly label: string | null;
}

export interface AggregatedVerdict {
  readonly intentId: string;
  readonly toolId: string;

  /** The `VerificationPolicy` whose checks produced the votes. */
  readonly policyId: string | null;
  readonly policyVersion: number | null;

  /**
   * The `DecisionPolicy` that turned those votes into this status.
   *
   * Every verdict must record *exactly* the policy version it was
   * decided under. Both pairs are recorded because both can change
   * independently, and a dispute that knows only one of them cannot be replayed.
   */
  readonly decisionPolicyId: string;
  readonly decisionPolicyVersion: number;
  readonly lifecycle: PolicyLifecycle;

  readonly status: VerdictStatus;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly score: number | null;
  readonly costUsd: number;

  readonly tally: VoteTally;
  readonly decidedBy: DecidedBy;
  /**
   * Every declared verifier's result, in declaration order.
   *
   * The evidence half of the verdict, and the half settlement never sees — see
   * `./settlement-decision.ts` for the boundary and why it exists.
   */
  readonly verifiers: readonly VerifierResult[];

  /**
   * This verdict has no economic effect.
   *
   * True for every lifecycle except `ACTIVE`, which is two situations with one
   * consequence: the policy has not been through the promote gate, or it has
   * been pulled by the kill switch. {@link lifecycle} is which — a receipt
   * needs to distinguish "not live yet" from "we withdrew this", and
   * settlement needs neither.
   */
  readonly shadow: boolean;
  readonly evaluatedAt: Date;
}

export interface AggregateInput {
  readonly intentId: string;
  readonly toolId: string;
  readonly decisionPolicy: DecisionPolicy;
  /**
   * Resolved by the store, never read off the policy document.
   *
   * See {@link enforces}: a document that could declare itself enforcing would
   * make the promote gate advisory.
   */
  readonly lifecycle: PolicyLifecycle;
  readonly results: readonly VerifierResult[];
  readonly policyId?: string;
  readonly policyVersion?: number;
  readonly evaluatedAt: Date;
}

export function aggregate(input: AggregateInput): AggregatedVerdict {
  const { decisionPolicy: policy } = input;

  const verifiers = alignToDeclared(policy, input.results);
  const tally = tallyVotes(policy, input.results, verifiers);
  const match = firstMatchingClause(policy.clauses, tally, verifiers);

  const status = match ? match.clause.then : defaultStatus(policy, verifiers);
  const decidedBy: DecidedBy = {
    clauseIndex: match ? match.index : null,
    trigger: match ? match.clause.when : null,
    label: match?.clause.label ?? null,
  };

  return {
    intentId: input.intentId,
    toolId: input.toolId,
    policyId: input.policyId ?? null,
    policyVersion: input.policyVersion ?? null,
    decisionPolicyId: policy.id,
    decisionPolicyVersion: policy.version,
    lifecycle: input.lifecycle,
    status,
    reasonCode: status === VerdictStatus.PASS ? null : reasonCodeFor(match, verifiers),
    reason: status === VerdictStatus.PASS ? null : reasonFor(match, tally, verifiers),
    score: aggregateScore(match, verifiers),
    costUsd: verifiers.reduce((total, result) => total + result.costUsd, 0),
    tally,
    decidedBy,
    verifiers,
    shadow: !enforces(input.lifecycle),
    evaluatedAt: input.evaluatedAt,
  };
}

/**
 * The verdict when no clause matched.
 *
 * `policy.otherwise` unless a verifier carried a passing verdict of its own —
 * see `VerifierResult.decides`. The deterministic stage passing an empty result
 * set is the case this exists for: the vote is a `PASS`, the *verdict* is
 * `EMPTY_UNVERIFIED`, and collapsing the second into the first would pay the
 * provider correctly while destroying the coverage metric that says how often
 * we pay for an empty answer nothing corroborated.
 *
 * A striking `decides` is dropped, loudly enough to be worth stating: only a
 * clause may strike, because only a clause is versioned, promoted and killable.
 * A verifier that could settle a `FAIL` by itself would hold a veto no policy
 * author granted it, and would keep holding it after the policy was rewritten.
 */
function defaultStatus(
  policy: DecisionPolicy,
  verifiers: readonly VerifierResult[],
): VerdictStatus {
  const carried = verifiers.find(
    (result) =>
      result.decides !== null &&
      result.decides !== undefined &&
      !VERDICT_CONSEQUENCE[result.decides].strike,
  );

  return carried?.decides ?? policy.otherwise;
}

/**
 * The declared verifier set, filled in from the results that arrived.
 *
 * A declared verifier with no result becomes `UNAVAILABLE` rather than
 * vanishing — rule 1 in this file's header. Order follows the policy document
 * so that two verdicts for the same tool are read side by side without
 * re-sorting.
 */
function alignToDeclared(
  policy: DecisionPolicy,
  results: readonly VerifierResult[],
): readonly VerifierResult[] {
  const byId = new Map(results.map((result) => [result.verifierId, result]));

  return policy.verifiers.map(
    (declared): VerifierResult =>
      byId.get(declared.verifierId) ?? {
        verifierId: declared.verifierId,
        outcome: VerifierOutcome.UNAVAILABLE,
        code: 'verifier_no_result',
        detail: 'This check produced no result.',
        score: null,
        costUsd: 0,
        stage: null,
      },
  );
}

function tallyVotes(
  policy: DecisionPolicy,
  supplied: readonly VerifierResult[],
  aligned: readonly VerifierResult[],
): VoteTally {
  const declaredIds = new Set(policy.verifiers.map((verifier) => verifier.verifierId));
  const count = (outcome: VerifierOutcome) =>
    aligned.filter((result) => result.outcome === outcome).length;

  const votes = aligned.filter((result) => isVote(result.outcome)).length;
  const failed = count(VerifierOutcome.FAIL);

  return {
    declared: policy.verifiers.length,
    votes,
    passed: count(VerifierOutcome.PASS),
    failed,
    misapplied: count(VerifierOutcome.MISAPPLIED),
    unavailable: count(VerifierOutcome.UNAVAILABLE),
    abstained: count(VerifierOutcome.ABSTAIN),
    failedFraction: votes === 0 ? null : failed / votes,
    unregistered: supplied.filter((result) => !declaredIds.has(result.verifierId)).length,
  };
}

interface ClauseMatch {
  readonly clause: DecisionClause;
  readonly index: number;
}

function firstMatchingClause(
  clauses: readonly DecisionClause[],
  tally: VoteTally,
  verifiers: readonly VerifierResult[],
): ClauseMatch | null {
  for (let index = 0; index < clauses.length; index += 1) {
    if (clauseMatches(clauses[index], tally, verifiers)) {
      return { clause: clauses[index], index };
    }
  }
  return null;
}

function clauseMatches(
  clause: DecisionClause,
  tally: VoteTally,
  verifiers: readonly VerifierResult[],
): boolean {
  switch (clause.when) {
    case DecisionTrigger.FAILURES_AT_LEAST:
      return tally.failed >= clause.count;
    case DecisionTrigger.FAILED_FRACTION_AT_LEAST:
      // `null` — nobody voted — never matches. A fraction clause on an empty
      // denominator has no answer, and inventing `0` would fire a `>= 0` clause
      // on a call where no verifier ran at all.
      return tally.failedFraction !== null && tally.failedFraction >= clause.fraction;
    case DecisionTrigger.VERIFIER_FAILED:
      return verifiers.some(
        (result) =>
          result.verifierId === clause.verifierId && result.outcome === VerifierOutcome.FAIL,
      );
    case DecisionTrigger.MISAPPLIED_AT_LEAST:
      return tally.misapplied >= clause.count;
    case DecisionTrigger.VOTES_BELOW:
      return tally.votes < clause.count;
  }
}

/**
 * The verdict's machine-readable reason.
 *
 * A veto clause borrows the vetoing verifier's own code — a receipt for a
 * schema veto should say `schema_invalid`, not `clause_verifier_failed`, since
 * the specific reason is what a provider can act on. Every other clause reports
 * the trigger, because the fact that decided the call is the *pattern* and no
 * single verifier's code describes it.
 */
function reasonCodeFor(
  match: ClauseMatch | null,
  verifiers: readonly VerifierResult[],
): string | null {
  if (!match) return 'no_clause_matched';
  const { clause } = match;

  if (clause.when === DecisionTrigger.VERIFIER_FAILED) {
    const vetoing = findVerifier(verifiers, clause.verifierId);
    if (vetoing?.code) return vetoing.code;
  }

  return `quorum_${clause.when.toLowerCase()}`;
}

function findVerifier(
  verifiers: readonly VerifierResult[],
  verifierId: string,
): VerifierResult | undefined {
  return verifiers.find((result) => result.verifierId === verifierId);
}

function reasonFor(
  match: ClauseMatch | null,
  tally: VoteTally,
  verifiers: readonly VerifierResult[],
): string | null {
  if (!match) return null;
  const { clause } = match;
  if (clause.label) return clause.label;

  switch (clause.when) {
    case DecisionTrigger.FAILURES_AT_LEAST:
      return `${tally.failed} of ${tally.declared} checks did not pass.`;
    case DecisionTrigger.FAILED_FRACTION_AT_LEAST:
      return `${tally.failed} of the ${tally.votes} checks that ran did not pass.`;
    case DecisionTrigger.VERIFIER_FAILED: {
      const vetoing = findVerifier(verifiers, clause.verifierId);
      return vetoing?.detail ?? `The ${clause.verifierId} check did not pass.`;
    }
    case DecisionTrigger.MISAPPLIED_AT_LEAST:
      return `${tally.misapplied} check(s) did not fit this response — you were not charged.`;
    case DecisionTrigger.VOTES_BELOW:
      return `Only ${tally.votes} of ${tally.declared} checks could run.`;
  }
}

/**
 * The verdict's headline score.
 *
 * A veto reports the vetoing verifier's score; anything else reports the
 * **lowest** score among the verifiers that actually voted. Not the mean:
 * `../engine.ts` already refuses to average across stages because they are not
 * commensurable, and adding third-party verifiers to the set makes that worse,
 * not better. The minimum is the one summary that never claims more confidence
 * than the most pessimistic verifier had.
 *
 * `null` when nothing scored — a `0` there would read as "scored, and scored
 * badly" for a call nobody scored.
 */
function aggregateScore(
  match: ClauseMatch | null,
  verifiers: readonly VerifierResult[],
): number | null {
  const clause = match?.clause;
  if (clause?.when === DecisionTrigger.VERIFIER_FAILED) {
    const vetoing = findVerifier(verifiers, clause.verifierId);
    if (vetoing && vetoing.score !== null) return vetoing.score;
  }

  const scores = verifiers
    .filter((result) => isVote(result.outcome) && result.score !== null)
    .map((result) => result.score as number);

  return scores.length === 0 ? null : Math.min(...scores);
}

/**
 * Refuses a policy that could strike somebody for the wrong reason.
 *
 * Called at registration rather than at aggregation, so a malformed policy
 * fails in front of the person writing it instead of in front of the provider
 * it mis-slashes. Every check here is one that cannot be expressed in the type
 * system, and each one has a failure mode attached in the message.
 */
export function validateDecisionPolicy(policy: DecisionPolicy): void {
  const refuse = (reason: string): never => {
    throw VerificationErrors.decisionPolicyInvalid({
      policyId: policy.id,
      version: policy.version,
      reason,
    });
  };

  if (policy.verifiers.length === 0) {
    refuse('a policy with no verifiers can never observe anything');
  }

  const ids = policy.verifiers.map((verifier) => verifier.verifierId);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    // Two entries with one id means one result satisfies both slots in the
    // denominator, so "2 of 4" silently becomes "2 of 3".
    refuse(`duplicate verifier ids: ${[...new Set(duplicates)].join(', ')}`);
  }

  if (policy.otherwise === VerdictStatus.FAIL) {
    refuse('`otherwise` may not be FAIL — a policy must not strike when no clause matched');
  }

  const declared = new Set(ids);
  policy.clauses.forEach((clause, index) => {
    const at = `clause ${index} (${clause.when})`;

    switch (clause.when) {
      case DecisionTrigger.FAILURES_AT_LEAST:
      case DecisionTrigger.MISAPPLIED_AT_LEAST:
        if (!Number.isInteger(clause.count) || clause.count < 1) {
          // `count: 0` is matched by every call, including one where every
          // verifier passed.
          refuse(`${at}: count must be an integer >= 1`);
        }
        if (clause.count > policy.verifiers.length) {
          refuse(`${at}: count ${clause.count} exceeds the ${policy.verifiers.length} verifiers`);
        }
        break;

      case DecisionTrigger.VOTES_BELOW:
        if (!Number.isInteger(clause.count) || clause.count < 1) {
          refuse(`${at}: count must be an integer >= 1`);
        }
        break;

      case DecisionTrigger.FAILED_FRACTION_AT_LEAST:
        if (!(clause.fraction > 0) || clause.fraction > 1) {
          // `fraction: 0` matches a unanimous pass.
          refuse(`${at}: fraction must be in (0, 1]`);
        }
        break;

      case DecisionTrigger.VERIFIER_FAILED:
        if (!declared.has(clause.verifierId)) {
          // A veto naming a verifier the policy does not run is a clause that
          // can never fire, and it reads exactly like one that always does.
          refuse(`${at}: names undeclared verifier "${clause.verifierId}"`);
        }
        break;
    }
  });
}
