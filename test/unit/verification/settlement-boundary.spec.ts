import {
  AggregatedVerdict,
  DecisionPolicy,
  DecisionTrigger,
  PolicyLifecycle,
  SETTLEMENT_DECISION_FIELDS,
  VerdictOutcome,
  VerdictStatus,
  VerifierOutcome,
  VerifierResult,
  aggregate,
  settlementDecision,
} from '@modules/verification/domain';

/**
 * The seam between verification and settlement.
 *
 * A genuinely distributed quorum is out of scope for now, and the aggregator's
 * architecture must leave room for it. Leaving room is a claim
 * about what settlement is allowed to read, so it is testable, and these are
 * the tests: a decision carries a status and the identity of the policy that
 * issued it, and nothing about who voted.
 *
 * If a future change widens `SettlementDecision`, the first test here fails
 * before any settlement code can start depending on the new field.
 */

const EVALUATED_AT = new Date('2026-08-16T09:00:00.000Z');
const TOOL_ID = '7f1b9f4c-0f6a-4a15-9a3a-3f0b6a0a1b22';

function policy(verifierIds: readonly string[]): DecisionPolicy {
  return {
    id: 'search_web.default',
    version: 3,
    toolId: TOOL_ID,
    verifiers: verifierIds.map((verifierId) => ({ verifierId })),
    clauses: [{ when: DecisionTrigger.FAILURES_AT_LEAST, count: 2, then: VerdictStatus.FAIL }],
    otherwise: VerdictStatus.PASS,
  };
}

function vote(verifierId: string, outcome: VerifierOutcome): VerifierResult {
  return {
    verifierId,
    outcome,
    code: outcome === VerifierOutcome.FAIL ? `${verifierId}_failed` : null,
    detail: null,
    score: outcome === VerifierOutcome.FAIL ? 0.2 : 0.9,
    costUsd: 0,
    stage: null,
  };
}

function verdictWith(
  verifierIds: readonly string[],
  failing: readonly string[],
  lifecycle = PolicyLifecycle.ACTIVE,
): AggregatedVerdict {
  return aggregate({
    intentId: 'intent-1',
    toolId: TOOL_ID,
    decisionPolicy: policy(verifierIds),
    lifecycle,
    results: verifierIds.map((id) =>
      vote(id, failing.includes(id) ? VerifierOutcome.FAIL : VerifierOutcome.PASS),
    ),
    evaluatedAt: EVALUATED_AT,
  });
}

const FOUR = ['schema', 'rules', 'cross_check', 'semantic'];

describe('settlementDecision — what settlement may see', () => {
  it('carries exactly the declared field set and nothing else', () => {
    const decision = settlementDecision(verdictWith(FOUR, ['schema', 'rules']));

    expect(Object.keys(decision).sort()).toEqual([...SETTLEMENT_DECISION_FIELDS].sort());
  });

  it('carries no per-verifier evidence of any kind', () => {
    const decision = settlementDecision(verdictWith(FOUR, ['schema', 'rules']));
    const serialised = JSON.stringify(decision);

    for (const verifierId of FOUR) {
      expect(serialised).not.toContain(verifierId);
    }
    expect(serialised).not.toContain('tally');
    expect(serialised).not.toContain('decidedBy');
  });

  it('is frozen — a judgement is not editable by its consumer', () => {
    const decision = settlementDecision(verdictWith(FOUR, []));

    expect(Object.isFrozen(decision)).toBe(true);
    expect(() => {
      (decision as { settle: boolean }).settle = false;
    }).toThrow();
  });

  it('names the exact policy version that decided, so a settlement is replayable', () => {
    const decision = settlementDecision(verdictWith(FOUR, ['schema', 'rules']));

    expect(decision.decisionPolicyId).toBe('search_web.default');
    expect(decision.decisionPolicyVersion).toBe(3);
  });
});

describe('settlementDecision — adding a verifier does not change what settlement reads', () => {
  it('produces the same shape and the same instruction with five verifiers as with four', () => {
    // Two failures out of four, and the same two failures out of five once a
    // verifier we do not operate is declared and votes with the majority.
    const withFour = settlementDecision(verdictWith(FOUR, ['schema', 'rules']));
    const withFive = settlementDecision(verdictWith([...FOUR, 'acme.oracle'], ['schema', 'rules']));

    expect(Object.keys(withFive)).toEqual(Object.keys(withFour));
    expect(withFive.outcome).toBe(withFour.outcome);
    expect(withFive.strike).toBe(withFour.strike);
  });

  it('lets a third-party verifier change the verdict without changing the contract', () => {
    // One of ours fails; theirs is the second failure that reaches the quorum.
    const decision = settlementDecision(
      verdictWith([...FOUR, 'acme.oracle'], ['rules', 'acme.oracle']),
    );

    expect(decision.status).toBe(VerdictStatus.FAIL);
    expect(decision.outcome).toBe(VerdictOutcome.REFUND);
    expect(Object.keys(decision).sort()).toEqual([...SETTLEMENT_DECISION_FIELDS].sort());
  });
});

describe('settlementDecision — the consequence is resolved, not delegated', () => {
  it('an ACTIVE FAIL arrives as a refund with a strike', () => {
    const decision = settlementDecision(verdictWith(FOUR, ['schema', 'rules']));

    expect(decision).toMatchObject({
      status: VerdictStatus.FAIL,
      outcome: VerdictOutcome.REFUND,
      settle: false,
      strike: true,
      slashable: true,
    });
  });

  it('a SHADOW FAIL arrives as a settle with no strike, and settlement is not asked to remember why', () => {
    // The shadow rule is applied here rather than handed to settlement as a
    // flag. A call site cannot forget a rule it is never shown.
    const decision = settlementDecision(
      verdictWith(FOUR, ['schema', 'rules'], PolicyLifecycle.SHADOW),
    );

    expect(decision).toMatchObject({
      status: VerdictStatus.FAIL,
      outcome: VerdictOutcome.SETTLE,
      settle: true,
      strike: false,
      slashable: false,
    });
    expect(decision).not.toHaveProperty('shadow');
  });
});
