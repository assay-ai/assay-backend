import {
  KillScope,
  PolicyLifecycle,
  PromotionEvidence,
  VerdictOutcome,
  VerdictStatus,
  VerifierOutcome,
} from '@modules/verification/domain';

import {
  BAD_RESPONSE,
  EXTERNAL_VERIFIER_IDS,
  TEST_TOOL_ID,
  VerificationTestContext,
  checksPolicy,
  createVerificationTestContext,
  externalVote,
  quorumDraft,
} from '../helpers/verification-test-context';

/**
 * The kill switch, across two processes, against a real Redis.
 *
 * A wrong policy in production is an incident
 * that takes money from innocent people, so it *"must be possible to switch off
 * without a deploy"* — and take effect within seconds.
 *
 * A test that killed and read through one object would prove nothing about
 * either half of that. So the context here holds **two independent kill-switch
 * instances over one Redis**: `operator` is the console pod, `serving` is an
 * API pod, and they share no memory. What is measured is the wall-clock gap
 * between the operator's `kill()` returning and the serving pod's *next call*
 * no longer applying the policy.
 *
 * The suite also removes the pub/sub path and re-measures, because the fast
 * path is an optimisation and the poll is the mechanism. If only the broadcast
 * worked, one pod that missed a message during a reconnect would keep
 * enforcing a policy an operator believes they pulled.
 */

const EVALUATED_AT = new Date('2026-08-16T09:00:00.000Z');
const POLICY_ID = 'search_web.default';

/** With `BAD_RESPONSE` the built-in schema check fails too: 2 of 4. */
const ONE_EXTERNAL_FAIL = [
  externalVote(EXTERNAL_VERIFIER_IDS[0], VerifierOutcome.FAIL),
  externalVote(EXTERNAL_VERIFIER_IDS[1], VerifierOutcome.PASS),
];

const EVIDENCE: PromotionEvidence = {
  shadowCalls: 5_000,
  labelledSamples: 200,
  falsePositives: 2,
  requestedBy: 'alice',
  approvedBy: 'bob',
};

const POLL_INTERVAL_MS = 1_000;

describe('kill switch', () => {
  let context: VerificationTestContext;

  beforeAll(async () => {
    context = await createVerificationTestContext({ pollIntervalMs: POLL_INTERVAL_MS });
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
    await context.operator.register({
      draft: quorumDraft(),
      verificationPolicy: checksPolicy(),
      createdBy: 'alice',
      startIn: PolicyLifecycle.SHADOW,
    });
    await context.operator.promote(POLICY_ID, 1, EVIDENCE);
  });

  /** One call through the serving process, on a response 2 of 4 verifiers reject. */
  const judge = (intentId: string) =>
    context.serving.decide({
      intentId,
      toolId: TEST_TOOL_ID,
      response: BAD_RESPONSE,
      externalResults: ONE_EXTERNAL_FAIL,
      evaluatedAt: EVALUATED_AT,
    });

  it('applies the policy before it is killed', async () => {
    const before = await judge('intent-before');

    expect(before?.settlement).toMatchObject({
      status: VerdictStatus.FAIL,
      outcome: VerdictOutcome.REFUND,
      strike: true,
      slashable: true,
    });
    expect(before?.verdict.decidedBy.trigger).not.toBeNull();
  });

  /**
   * Judges repeatedly until the serving process stops applying the policy, and
   * returns how long that took.
   *
   * `-1` if it never did within the budget, which fails the assertion rather
   * than passing quietly.
   */
  async function msUntilWithdrawn(label: string, budgetMs = 10_000): Promise<number> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < budgetMs) {
      const outcome = await judge(`${label}-${Date.now() - startedAt}`);
      if (outcome?.verdict.reasonCode === 'policy_withdrawn') {
        return Date.now() - startedAt;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return -1;
  }

  it('stops applying the policy in another process, and does so within seconds', async () => {
    expect((await judge('intent-before'))?.settlement.strike).toBe(true);

    // `operatorKillSwitch.kill`, not `operator.withdraw`. `withdraw` also moves
    // the database row, and the serving process reads that row as a fallback —
    // so measuring against it would measure Postgres and report it as the kill
    // switch. Redis is the only channel here, which is what the
    // "without a deploy, effective in seconds" requirement is a claim about.
    const effectiveAfterMs = await withKill(
      { scope: KillScope.POLICY_VERSION, policyId: POLICY_ID, version: 1 },
      'the freshness rule is striking honest providers',
      () => msUntilWithdrawn('intent-probe'),
    );

    console.log(`kill switch took effect in the serving process after ${effectiveAfterMs}ms`);

    expect(effectiveAfterMs).toBeGreaterThanOrEqual(0);
    expect(effectiveAfterMs).toBeLessThan(5_000);
  });

  /** Engages the switch through Redis only, then runs the measurement. */
  async function withKill<T>(
    target: Parameters<typeof context.operatorKillSwitch.kill>[0],
    reason: string,
    measure: () => Promise<T>,
  ): Promise<T> {
    await context.operatorKillSwitch.kill(target, reason, 'oncall');
    return measure();
  }

  it('the withdrawn call is not judged by the policy at all — it is not merely inert', async () => {
    await context.operator.withdraw(POLICY_ID, 1, 'bad rule', 'oncall');
    await context.servingKillSwitch.refresh();

    const after = await judge('intent-after');

    expect(after?.verdict).toMatchObject({
      status: VerdictStatus.DEGRADED,
      reasonCode: 'policy_withdrawn',
      reason: 'bad rule',
      lifecycle: PolicyLifecycle.WITHDRAWN,
      // The clauses were never evaluated. A withdrawn policy that still
      // produced a FAIL — filed under shadow — would leave a receipt saying the
      // response failed, which a provider reads.
      verifiers: [],
    });
    expect(after?.verdict.decidedBy).toEqual({ clauseIndex: null, trigger: null, label: null });
    expect(after?.verdict.tally.declared).toBe(0);

    // And it pays.
    expect(after?.settlement).toMatchObject({
      outcome: VerdictOutcome.SETTLE,
      settle: true,
      strike: false,
      slashable: false,
    });
    // Still names the version that was pulled — an incident review counts what
    // the withdrawal affected.
    expect(after?.settlement.decisionPolicyVersion).toBe(1);
  });

  it('takes effect through the poll alone when the broadcast is lost', async () => {
    // Both shortcuts removed. The serving process's subscriber no longer
    // delivers, so the fast path is gone; and the kill goes to Redis only, so
    // the database fallback is gone too. The interval is the only thing left
    // that can carry the change — which is the point: pub/sub is fire and
    // forget, and a pod that missed one message must not keep enforcing a
    // policy an operator believes they pulled.
    context.silenceBroadcasts();

    const effectiveAfterMs = await withKill(
      { scope: KillScope.POLICY_VERSION, policyId: POLICY_ID, version: 1 },
      'broadcast dropped',
      () => msUntilWithdrawn('intent-poll'),
    );

    console.log(
      `kill switch took effect through the poll alone after ${effectiveAfterMs}ms ` +
        `(poll interval ${POLL_INTERVAL_MS}ms)`,
    );

    expect(effectiveAfterMs).toBeGreaterThanOrEqual(0);
    // The bound is the poll interval plus a round trip, not a hope. It is also
    // a lower bound worth stating: without the broadcast this cannot be
    // instant, so a near-zero result here would mean some other path carried it
    // and the poll is not actually being exercised.
    expect(effectiveAfterMs).toBeLessThan(POLL_INTERVAL_MS * 3);
  });

  it('a withdrawal survives losing the Redis entry, because the row also records it', async () => {
    // The other half of the two-source read. `withdraw()` writes Redis first —
    // that is what stops the policy — and the row second. If the Redis entry is
    // later flushed or expires, the policy must not quietly resume enforcing.
    await context.operator.withdraw(POLICY_ID, 1, 'bad rule', 'oncall');
    await context.forgetKillSwitchState();

    expect(context.servingKillSwitch.isKilled(POLICY_ID, 1)).toBeNull();

    const outcome = await judge('intent-redis-lost');
    expect(outcome?.verdict.reasonCode).toBe('policy_withdrawn');
    expect(outcome?.settlement.strike).toBe(false);
  });

  it('leaves other versions of the same policy enforcing', async () => {
    // Killing a bad v2 must not disarm the v1 that was fine last week.
    await context.operator.withdraw(POLICY_ID, 2, 'a version that is not serving', 'oncall');
    await context.servingKillSwitch.refresh();

    expect((await judge('intent-other-version'))?.settlement.strike).toBe(true);
  });

  it('a global halt withdraws every policy', async () => {
    await context.operatorKillSwitch.kill(
      { scope: KillScope.GLOBAL },
      'bad verifier deploy — halting verification',
      'oncall',
    );
    await context.servingKillSwitch.refresh();

    const outcome = await judge('intent-global');

    expect(outcome?.verdict.reasonCode).toBe('policy_withdrawn');
    expect(outcome?.verdict.reason).toBe('bad verifier deploy — halting verification');
    expect(outcome?.settlement.strike).toBe(false);
  });

  it('records the withdrawal durably, and reinstates only as far as SHADOW', async () => {
    await context.operator.withdraw(POLICY_ID, 1, 'bad rule', 'oncall');

    const withdrawn = await context.policies.findVersion(POLICY_ID, 1);
    expect(withdrawn).toMatchObject({
      lifecycle: PolicyLifecycle.WITHDRAWN,
      withdrawnBy: 'oncall',
      withdrawnReason: 'bad rule',
    });
    expect(withdrawn?.withdrawnAt).not.toBeNull();

    await context.operator.reinstate(POLICY_ID, 1, 'oncall');
    await context.servingKillSwitch.refresh();

    // Back in service and back under the gate: a policy that was pulled has to
    // re-earn enforcement.
    const reinstated = await context.policies.findVersion(POLICY_ID, 1);
    expect(reinstated?.lifecycle).toBe(PolicyLifecycle.SHADOW);

    const outcome = await judge('intent-reinstated');
    expect(outcome?.verdict.status).toBe(VerdictStatus.FAIL);
    expect(outcome?.settlement).toMatchObject({ strike: false, settle: true });
  });
});
