import {
  AggregatedVerdict,
  BUILT_IN_VERIFIER_ID,
  DecisionPolicy,
  DecisionTrigger,
  PolicyLifecycle,
  VERDICT_CONSEQUENCE,
  VerdictOutcome,
  VerdictStatus,
  VerificationStage,
  VerifierOutcome,
  VerifierResult,
  aggregate,
  effectiveConsequence,
  validateDecisionPolicy,
} from '@modules/verification/domain';

/**
 * The aggregator: quorum arithmetic, the policy version on every
 * verdict, and the safety rules that keep a malformed policy from striking
 * somebody.
 *
 * The headline case is *"2 out of 4 fail, then FAIL"* — and the two halves of
 * it that matter are that **one** failure out of four is not a `FAIL`, and that the fourth verifier being
 * missing does not quietly turn "2 of 4" into "2 of 3".
 */

const EVALUATED_AT = new Date('2026-08-16T09:00:00.000Z');
const TOOL_ID = '7f1b9f4c-0f6a-4a15-9a3a-3f0b6a0a1b22';

const VERIFIER_IDS = ['schema', 'rules', 'cross_check', 'semantic'] as const;

/** The canonical four-verifier policy with the reference quorum rule. */
function quorumPolicy(overrides: Partial<DecisionPolicy> = {}): DecisionPolicy {
  return {
    id: 'search_web.default',
    version: 3,
    toolId: TOOL_ID,
    verifiers: VERIFIER_IDS.map((verifierId) => ({ verifierId })),
    clauses: [
      {
        when: DecisionTrigger.FAILURES_AT_LEAST,
        count: 2,
        then: VerdictStatus.FAIL,
        label: '2 of the 4 checks disagreed with this response.',
      },
    ],
    otherwise: VerdictStatus.PASS,
    ...overrides,
  };
}

function vote(
  verifierId: string,
  outcome: VerifierOutcome,
  overrides: Partial<VerifierResult> = {},
): VerifierResult {
  return {
    verifierId,
    outcome,
    code: outcome === VerifierOutcome.PASS ? null : `${verifierId}_said_no`,
    detail: outcome === VerifierOutcome.PASS ? null : `The ${verifierId} check did not pass.`,
    score: null,
    costUsd: 0,
    stage: null,
    ...overrides,
  };
}

/** `failures` of the four verifiers fail; the rest pass. */
function votesWithFailures(failures: number): VerifierResult[] {
  return VERIFIER_IDS.map((id, index) =>
    vote(id, index < failures ? VerifierOutcome.FAIL : VerifierOutcome.PASS),
  );
}

function run(
  policy: DecisionPolicy,
  results: readonly VerifierResult[],
  lifecycle = PolicyLifecycle.ACTIVE,
): AggregatedVerdict {
  return aggregate({
    intentId: 'intent-1',
    toolId: TOOL_ID,
    decisionPolicy: policy,
    lifecycle,
    results,
    policyId: 'search_web.checks',
    policyVersion: 7,
    evaluatedAt: EVALUATED_AT,
  });
}

describe('aggregate — the threshold rule', () => {
  it('passes when 1 of 4 verifiers fails', () => {
    const verdict = run(quorumPolicy(), votesWithFailures(1));

    expect(verdict.status).toBe(VerdictStatus.PASS);
    expect(verdict.tally).toMatchObject({ declared: 4, votes: 4, passed: 3, failed: 1 });
    expect(verdict.decidedBy.clauseIndex).toBeNull();
    expect(verdict.reasonCode).toBeNull();
  });

  it('fails when 2 of 4 verifiers fail', () => {
    const verdict = run(quorumPolicy(), votesWithFailures(2));

    expect(verdict.status).toBe(VerdictStatus.FAIL);
    expect(verdict.tally).toMatchObject({ declared: 4, votes: 4, passed: 2, failed: 2 });
    expect(verdict.decidedBy).toEqual({
      clauseIndex: 0,
      trigger: DecisionTrigger.FAILURES_AT_LEAST,
      label: '2 of the 4 checks disagreed with this response.',
    });
    expect(verdict.reason).toBe('2 of the 4 checks disagreed with this response.');
  });

  it('is the policy that decides the threshold, not the code', () => {
    // The same votes, a policy that says three. Nothing about the aggregator
    // changes — which is the property that lets a threshold be tuned without a
    // deploy.
    const strict = quorumPolicy({
      clauses: [{ when: DecisionTrigger.FAILURES_AT_LEAST, count: 3, then: VerdictStatus.FAIL }],
    });

    expect(run(strict, votesWithFailures(2)).status).toBe(VerdictStatus.PASS);
    expect(run(strict, votesWithFailures(3)).status).toBe(VerdictStatus.FAIL);
  });

  it('counts a verifier that produced nothing as unavailable, not as absent', () => {
    // Two failures and two silent verifiers. "2 of 4" must still be 2 of 4 —
    // if the denominator shrank to the results that turned up, this would read
    // as a unanimous failure and, worse, a `FAILED_FRACTION` policy would fire.
    const verdict = run(quorumPolicy(), [
      vote('schema', VerifierOutcome.FAIL),
      vote('rules', VerifierOutcome.FAIL),
    ]);

    expect(verdict.tally).toMatchObject({ declared: 4, votes: 2, failed: 2, unavailable: 2 });
    expect(verdict.verifiers).toHaveLength(4);
    expect(verdict.verifiers[2]).toMatchObject({
      verifierId: 'cross_check',
      outcome: VerifierOutcome.UNAVAILABLE,
      code: 'verifier_no_result',
    });
  });

  it('does not count abstentions or misapplied checks as votes', () => {
    const verdict = run(quorumPolicy(), [
      vote('schema', VerifierOutcome.FAIL),
      vote('rules', VerifierOutcome.PASS),
      vote('cross_check', VerifierOutcome.ABSTAIN),
      vote('semantic', VerifierOutcome.MISAPPLIED),
    ]);

    expect(verdict.tally).toMatchObject({
      votes: 2,
      passed: 1,
      failed: 1,
      abstained: 1,
      misapplied: 1,
      failedFraction: 0.5,
    });
    expect(verdict.status).toBe(VerdictStatus.PASS);
  });

  it('never matches a fraction clause when nobody voted', () => {
    // `failedFraction` is null, not 0. A `>= 0.5` clause on an empty
    // denominator has no answer, and inventing one strikes on silence.
    const fractional = quorumPolicy({
      clauses: [
        {
          when: DecisionTrigger.FAILED_FRACTION_AT_LEAST,
          fraction: 0.5,
          then: VerdictStatus.FAIL,
        },
      ],
    });

    const verdict = run(fractional, []);

    expect(verdict.tally.failedFraction).toBeNull();
    expect(verdict.status).toBe(VerdictStatus.PASS);
  });
});

describe('aggregate — clause order and vetoes', () => {
  const layered = quorumPolicy({
    clauses: [
      {
        when: DecisionTrigger.MISAPPLIED_AT_LEAST,
        count: 1,
        then: VerdictStatus.MISAPPLIED,
      },
      { when: DecisionTrigger.VERIFIER_FAILED, verifierId: 'schema', then: VerdictStatus.FAIL },
      { when: DecisionTrigger.FAILURES_AT_LEAST, count: 2, then: VerdictStatus.FAIL },
      { when: DecisionTrigger.VOTES_BELOW, count: 2, then: VerdictStatus.DEGRADED },
    ],
  });

  it('lets a misapplied check outrank a quorum that would have struck', () => {
    // Three failures, but one verifier admits its check did not fit. A policy
    // that is wrong about one verifier has not earned the right to strike on
    // the strength of another.
    const verdict = run(layered, [
      vote('schema', VerifierOutcome.FAIL),
      vote('rules', VerifierOutcome.FAIL),
      vote('cross_check', VerifierOutcome.FAIL),
      vote('semantic', VerifierOutcome.MISAPPLIED),
    ]);

    expect(verdict.status).toBe(VerdictStatus.MISAPPLIED);
    expect(VERDICT_CONSEQUENCE[verdict.status].strike).toBe(false);
    expect(verdict.decidedBy.trigger).toBe(DecisionTrigger.MISAPPLIED_AT_LEAST);
  });

  it('honours a single-verifier veto and borrows its reason code', () => {
    const verdict = run(layered, [
      vote('schema', VerifierOutcome.FAIL, {
        code: 'schema_invalid',
        detail: 'results[0].url is missing.',
        score: 0.1,
      }),
      vote('rules', VerifierOutcome.PASS),
      vote('cross_check', VerifierOutcome.PASS),
      vote('semantic', VerifierOutcome.PASS),
    ]);

    expect(verdict.status).toBe(VerdictStatus.FAIL);
    expect(verdict.reasonCode).toBe('schema_invalid');
    expect(verdict.reason).toBe('results[0].url is missing.');
    expect(verdict.score).toBe(0.1);
  });

  it('degrades rather than strikes when too few verifiers could run', () => {
    const verdict = run(layered, [
      vote('rules', VerifierOutcome.FAIL),
      vote('cross_check', VerifierOutcome.UNAVAILABLE),
      vote('semantic', VerifierOutcome.UNAVAILABLE),
    ]);

    expect(verdict.status).toBe(VerdictStatus.DEGRADED);
    expect(VERDICT_CONSEQUENCE[verdict.status].settle).toBe(true);
  });
});

describe('aggregate — the third-party verifier seam', () => {
  it('counts a verifier we do not operate once the policy declares it', () => {
    const withThirdParty = quorumPolicy({
      verifiers: [
        ...VERIFIER_IDS.map((verifierId) => ({ verifierId })),
        { verifierId: 'acme.oracle' },
      ],
    });

    const oneOursOneTheirs = run(withThirdParty, [
      vote('schema', VerifierOutcome.PASS),
      vote('rules', VerifierOutcome.FAIL),
      vote('cross_check', VerifierOutcome.PASS),
      vote('semantic', VerifierOutcome.PASS),
      vote('acme.oracle', VerifierOutcome.FAIL),
    ]);

    expect(oneOursOneTheirs.tally).toMatchObject({ declared: 5, votes: 5, failed: 2 });
    expect(oneOursOneTheirs.status).toBe(VerdictStatus.FAIL);
  });

  it('discards a vote from a verifier the policy does not declare, and counts it', () => {
    // The safety rule that makes the open `verifierId` safe: anything able to
    // construct a `VerifierResult` would otherwise be able to swing a quorum
    // without passing the version, promotion or kill-switch gates.
    const verdict = run(quorumPolicy(), [
      ...votesWithFailures(1),
      vote('rogue.verifier', VerifierOutcome.FAIL),
    ]);

    expect(verdict.status).toBe(VerdictStatus.PASS);
    expect(verdict.tally.unregistered).toBe(1);
    expect(verdict.verifiers.map((result) => result.verifierId)).toEqual([...VERIFIER_IDS]);
  });
});

describe('aggregate — the policy version on the verdict', () => {
  it('records exactly the decision policy version that decided the call', () => {
    const verdict = run(quorumPolicy({ version: 3 }), votesWithFailures(2));

    expect(verdict.decisionPolicyId).toBe('search_web.default');
    expect(verdict.decisionPolicyVersion).toBe(3);
  });

  it('records the checks policy version separately from the decision policy', () => {
    // Two documents that change for different reasons, so a dispute that knows
    // only one of them cannot replay the call.
    const verdict = run(quorumPolicy({ version: 4 }), votesWithFailures(2));

    expect(verdict.decisionPolicyVersion).toBe(4);
    expect(verdict.policyId).toBe('search_web.checks');
    expect(verdict.policyVersion).toBe(7);
  });

  it('carries the version through to a verdict decided by no clause at all', () => {
    const verdict = run(quorumPolicy({ version: 11 }), votesWithFailures(0));

    expect(verdict.status).toBe(VerdictStatus.PASS);
    expect(verdict.decisionPolicyVersion).toBe(11);
  });

  it('changes the verdict when the version changes, and says which version said so', () => {
    const lenient = quorumPolicy({
      version: 5,
      clauses: [{ when: DecisionTrigger.FAILURES_AT_LEAST, count: 3, then: VerdictStatus.FAIL }],
    });
    const strict = quorumPolicy({ version: 6 });

    const underV5 = run(lenient, votesWithFailures(2));
    const underV6 = run(strict, votesWithFailures(2));

    expect([underV5.decisionPolicyVersion, underV5.status]).toEqual([5, VerdictStatus.PASS]);
    expect([underV6.decisionPolicyVersion, underV6.status]).toEqual([6, VerdictStatus.FAIL]);
  });
});

describe('aggregate — lifecycle decides economic effect', () => {
  it('an ACTIVE policy enforces', () => {
    const verdict = run(quorumPolicy(), votesWithFailures(2), PolicyLifecycle.ACTIVE);

    expect(verdict.shadow).toBe(false);
    expect(effectiveConsequence(verdict).outcome).toBe(VerdictOutcome.REFUND);
    expect(effectiveConsequence(verdict).strike).toBe(true);
  });

  it.each([PolicyLifecycle.SHADOW, PolicyLifecycle.DRAFT, PolicyLifecycle.WITHDRAWN])(
    'a %s policy computes the same FAIL and cannot act on it',
    (lifecycle) => {
      const verdict = run(quorumPolicy(), votesWithFailures(2), lifecycle);

      expect(verdict.status).toBe(VerdictStatus.FAIL);
      expect(verdict.shadow).toBe(true);
      expect(effectiveConsequence(verdict).outcome).toBe(VerdictOutcome.SETTLE);
      expect(effectiveConsequence(verdict).strike).toBe(false);
      expect(effectiveConsequence(verdict).slashable).toBe(false);
    },
  );
});

describe('aggregate — a passing verdict a verifier settled itself', () => {
  it('keeps EMPTY_UNVERIFIED rather than collapsing it to PASS', () => {
    // The deterministic stage passing an empty result set votes `PASS` and
    // decides `EMPTY_UNVERIFIED`. Both statuses pay; only one carries the
    // coverage signal that says we paid without corroboration.
    const verdict = run(quorumPolicy(), [
      vote('schema', VerifierOutcome.PASS),
      vote('rules', VerifierOutcome.PASS, {
        decides: VerdictStatus.EMPTY_UNVERIFIED,
        stage: VerificationStage.DETERMINISTIC_RULES,
      }),
      vote('cross_check', VerifierOutcome.ABSTAIN),
      vote('semantic', VerifierOutcome.ABSTAIN),
    ]);

    expect(verdict.status).toBe(VerdictStatus.EMPTY_UNVERIFIED);
    expect(VERDICT_CONSEQUENCE[verdict.status].metric).toBe('coverage');
  });

  it('never lets a verifier settle a striking status by itself', () => {
    // Only a clause may strike, because only a clause is versioned, promoted
    // and killable. A `decides: FAIL` is dropped, not honoured.
    const verdict = run(quorumPolicy(), [
      vote('schema', VerifierOutcome.PASS),
      vote('rules', VerifierOutcome.PASS, { decides: VerdictStatus.FAIL }),
      vote('cross_check', VerifierOutcome.PASS),
      vote('semantic', VerifierOutcome.PASS),
    ]);

    expect(verdict.status).toBe(VerdictStatus.PASS);
  });

  it('a clause still outranks a verifier-settled status', () => {
    const verdict = run(quorumPolicy(), [
      vote('schema', VerifierOutcome.FAIL),
      vote('rules', VerifierOutcome.FAIL, { decides: VerdictStatus.EMPTY_UNVERIFIED }),
      vote('cross_check', VerifierOutcome.PASS),
      vote('semantic', VerifierOutcome.PASS),
    ]);

    expect(verdict.status).toBe(VerdictStatus.FAIL);
  });
});

describe('validateDecisionPolicy — what a policy may not say', () => {
  it('refuses a default of FAIL', () => {
    expect(() => validateDecisionPolicy(quorumPolicy({ otherwise: VerdictStatus.FAIL }))).toThrow(
      /may not be FAIL/,
    );
  });

  it('refuses a threshold of zero, which every call satisfies', () => {
    expect(() =>
      validateDecisionPolicy(
        quorumPolicy({
          clauses: [
            { when: DecisionTrigger.FAILURES_AT_LEAST, count: 0, then: VerdictStatus.FAIL },
          ],
        }),
      ),
    ).toThrow(/integer >= 1/);
  });

  it('refuses a threshold no verifier set could reach', () => {
    expect(() =>
      validateDecisionPolicy(
        quorumPolicy({
          clauses: [
            { when: DecisionTrigger.FAILURES_AT_LEAST, count: 9, then: VerdictStatus.FAIL },
          ],
        }),
      ),
    ).toThrow(/exceeds the 4 verifiers/);
  });

  it('refuses a veto naming a verifier the policy does not run', () => {
    expect(() =>
      validateDecisionPolicy(
        quorumPolicy({
          clauses: [
            { when: DecisionTrigger.VERIFIER_FAILED, verifierId: 'typo', then: VerdictStatus.FAIL },
          ],
        }),
      ),
    ).toThrow(/undeclared verifier "typo"/);
  });

  it('refuses duplicate verifier ids, which shrink the denominator', () => {
    expect(() =>
      validateDecisionPolicy(
        quorumPolicy({
          verifiers: [{ verifierId: 'schema' }, { verifierId: 'schema' }, { verifierId: 'rules' }],
        }),
      ),
    ).toThrow(/duplicate verifier ids: schema/);
  });

  it('refuses a policy with no verifiers', () => {
    expect(() => validateDecisionPolicy(quorumPolicy({ verifiers: [], clauses: [] }))).toThrow(
      /never observe anything/,
    );
  });

  it('accepts the reference example', () => {
    expect(() => validateDecisionPolicy(quorumPolicy())).not.toThrow();
  });
});

describe('the built-in verifier ids', () => {
  it('names every pipeline stage exactly once', () => {
    const ids = Object.values(BUILT_IN_VERIFIER_ID);

    expect(new Set(ids).size).toBe(ids.length);
    expect(BUILT_IN_VERIFIER_ID[VerificationStage.DETERMINISTIC_RULES]).toBe('rules');
  });
});
