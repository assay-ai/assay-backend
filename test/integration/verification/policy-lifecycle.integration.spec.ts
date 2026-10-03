import {
  DecisionTrigger,
  PolicyLifecycle,
  PromotionEvidence,
  VerdictOutcome,
  VerdictStatus,
  VerifierOutcome,
} from '@modules/verification/domain';

import {
  BAD_RESPONSE,
  EXTERNAL_VERIFIER_IDS,
  GOOD_RESPONSE,
  TEST_TOOL_ID,
  VerificationTestContext,
  checksPolicy,
  createVerificationTestContext,
  externalVote,
  quorumDraft,
} from '../helpers/verification-test-context';

/**
 * The policy lifecycle and the promote gate against a real database.
 *
 * Shadow mode is *"mandatory, not advisory"*. A gate tested only against its
 * own pure function has been tested where it is easy; the question this suite asks is the one that decides
 * whether it is real:
 *
 * > **Can an unpromoted policy take somebody's money?**
 *
 * It is asked three ways — through the service, through a direct write to the
 * table, and by checking what the aggregator actually does with the resolved
 * policy — because the gate has three layers and any one of them being the only
 * real one would be a gate somebody can walk around.
 */

const EVALUATED_AT = new Date('2026-08-16T09:00:00.000Z');

/**
 * One third-party verifier disagrees, the other does not.
 *
 * Held constant across these cases so the *response* is the only variable: with
 * `BAD_RESPONSE` the built-in schema check fails too and the tally is 2 of 4;
 * with `GOOD_RESPONSE` both built-ins pass and it is 1 of 4.
 */
const ONE_EXTERNAL_FAIL = [
  externalVote(EXTERNAL_VERIFIER_IDS[0], VerifierOutcome.FAIL),
  externalVote(EXTERNAL_VERIFIER_IDS[1], VerifierOutcome.PASS),
];

function goodEvidence(overrides: Partial<PromotionEvidence> = {}): PromotionEvidence {
  return {
    shadowCalls: 5_000,
    labelledSamples: 200,
    falsePositives: 2,
    requestedBy: 'alice',
    approvedBy: 'bob',
    note: 'shadow dashboard #412',
    ...overrides,
  };
}

describe('policy lifecycle', () => {
  let context: VerificationTestContext;

  beforeAll(async () => {
    context = await createVerificationTestContext();
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  describe('registration and versioning', () => {
    it('assigns the next version rather than accepting one', async () => {
      const first = await context.operator.register({
        draft: quorumDraft(),
        verificationPolicy: checksPolicy(),
        createdBy: 'alice',
      });
      const second = await context.operator.register({
        draft: quorumDraft(),
        verificationPolicy: checksPolicy(),
        createdBy: 'alice',
      });

      expect([first.version, second.version]).toEqual([1, 2]);
    });

    it('refuses a policy whose default is to strike, before it is stored', async () => {
      await expect(
        context.operator.register({
          draft: { ...quorumDraft(), otherwise: VerdictStatus.FAIL },
          createdBy: 'alice',
        }),
      ).rejects.toMatchObject({ errorCode: 'VERIFICATION_DECISION_POLICY_INVALID' });

      expect(await context.policies.count()).toBe(0);
    });

    it('a DRAFT policy is not resolved for traffic at all', async () => {
      await context.operator.register({
        draft: quorumDraft(),
        verificationPolicy: checksPolicy(),
        createdBy: 'alice',
      });

      expect(await context.operator.resolveForTraffic(TEST_TOOL_ID)).toBeNull();
    });
  });

  describe('the promote gate', () => {
    beforeEach(async () => {
      await context.operator.register({
        draft: quorumDraft(),
        verificationPolicy: checksPolicy(),
        createdBy: 'alice',
        startIn: PolicyLifecycle.SHADOW,
      });
    });

    it('refuses promotion on thin evidence and says every reason at once', async () => {
      await expect(
        context.operator.promote(
          'search_web.default',
          1,
          goodEvidence({ shadowCalls: 20, labelledSamples: 4, falsePositives: 3 }),
        ),
      ).rejects.toMatchObject({ errorCode: 'VERIFICATION_POLICY_PROMOTION_REFUSED' });

      const row = await context.policies.findVersion('search_web.default', 1);
      expect(row?.lifecycle).toBe(PolicyLifecycle.SHADOW);
      expect(row?.promotedAt).toBeNull();
    });

    it('refuses a self-approval', async () => {
      await expect(
        context.operator.promote(
          'search_web.default',
          1,
          goodEvidence({ requestedBy: 'alice', approvedBy: 'alice' }),
        ),
      ).rejects.toMatchObject({ errorCode: 'VERIFICATION_POLICY_PROMOTION_REFUSED' });
    });

    it('promotes on evidence that clears the bar, and records who approved it', async () => {
      await context.operator.promote('search_web.default', 1, goodEvidence());

      const row = await context.policies.findVersion('search_web.default', 1);
      expect(row?.lifecycle).toBe(PolicyLifecycle.ACTIVE);
      expect(row?.promotedBy).toBe('bob');
      expect(row?.promotionEvidence).toMatchObject({ falsePositiveRate: 0.01 });
    });

    it('the database refuses an ACTIVE row with no promotion record', async () => {
      // The layer no service, migration script or psql session can route
      // around. Without it, everything above is a convention.
      await expect(
        context.dataSource.query(
          `UPDATE "verification_policies" SET "lifecycle" = 'ACTIVE' WHERE "policy_id" = $1`,
          ['search_web.default'],
        ),
      ).rejects.toThrow(/chk_verification_policies_active_is_promoted/);
    });

    it('allows at most one ACTIVE version per tool', async () => {
      await context.operator.promote('search_web.default', 1, goodEvidence());

      await context.operator.register({
        draft: quorumDraft(),
        verificationPolicy: checksPolicy(),
        createdBy: 'alice',
        startIn: PolicyLifecycle.SHADOW,
      });
      await context.operator.promote('search_web.default', 2, goodEvidence());

      const active = await context.policies.find({
        where: { toolId: TEST_TOOL_ID, lifecycle: PolicyLifecycle.ACTIVE },
      });
      expect(active.map((row) => row.policyVersion)).toEqual([2]);

      const superseded = await context.policies.findVersion('search_web.default', 1);
      expect(superseded?.lifecycle).toBe(PolicyLifecycle.ARCHIVED);
    });
  });

  describe('what an unpromoted policy may do to real traffic', () => {
    beforeEach(async () => {
      await context.operator.register({
        draft: quorumDraft(),
        verificationPolicy: checksPolicy(),
        createdBy: 'alice',
        startIn: PolicyLifecycle.SHADOW,
      });
    });

    it('judges live calls and cannot act on the judgement', async () => {
      const outcome = await context.serving.decide({
        intentId: 'intent-shadow',
        toolId: TEST_TOOL_ID,
        response: BAD_RESPONSE,
        externalResults: ONE_EXTERNAL_FAIL,
        evaluatedAt: EVALUATED_AT,
      });

      // The verdict is computed — that is the whole point of shadow mode, and
      // the only way to measure the false-positive rate the gate asks for.
      expect(outcome?.verdict.status).toBe(VerdictStatus.FAIL);
      expect(outcome?.verdict.lifecycle).toBe(PolicyLifecycle.SHADOW);
      expect(outcome?.verdict.tally).toMatchObject({ declared: 4, failed: 2 });

      // And it moves no money.
      expect(outcome?.settlement).toMatchObject({
        outcome: VerdictOutcome.SETTLE,
        settle: true,
        strike: false,
        slashable: false,
      });
    });

    it('the same policy, promoted, refunds and strikes on the same call', async () => {
      await context.operator.promote('search_web.default', 1, goodEvidence());

      const outcome = await context.serving.decide({
        intentId: 'intent-active',
        toolId: TEST_TOOL_ID,
        response: BAD_RESPONSE,
        externalResults: ONE_EXTERNAL_FAIL,
        evaluatedAt: EVALUATED_AT,
      });

      expect(outcome?.verdict.lifecycle).toBe(PolicyLifecycle.ACTIVE);
      expect(outcome?.settlement).toMatchObject({
        status: VerdictStatus.FAIL,
        outcome: VerdictOutcome.REFUND,
        settle: false,
        strike: true,
        slashable: true,
      });
    });

    it('an ACTIVE policy still passes a call that only one verifier disliked', async () => {
      await context.operator.promote('search_web.default', 1, goodEvidence());

      const outcome = await context.serving.decide({
        intentId: 'intent-one-failure',
        toolId: TEST_TOOL_ID,
        response: GOOD_RESPONSE,
        externalResults: ONE_EXTERNAL_FAIL,
        evaluatedAt: EVALUATED_AT,
      });

      expect(outcome?.verdict.tally).toMatchObject({ declared: 4, failed: 1 });
      expect(outcome?.settlement).toMatchObject({
        status: VerdictStatus.PASS,
        outcome: VerdictOutcome.SETTLE,
        strike: false,
      });
    });
  });

  describe('the version recorded on a verdict', () => {
    it('is the version that actually decided the call', async () => {
      await context.operator.register({
        draft: quorumDraft(),
        verificationPolicy: checksPolicy(),
        createdBy: 'alice',
        startIn: PolicyLifecycle.SHADOW,
      });
      await context.operator.promote('search_web.default', 1, goodEvidence());

      const underV1 = await context.serving.decide({
        intentId: 'intent-v1',
        toolId: TEST_TOOL_ID,
        response: BAD_RESPONSE,
        externalResults: ONE_EXTERNAL_FAIL,
        evaluatedAt: EVALUATED_AT,
      });

      // v2 keeps the same verifiers and moves the threshold to three.
      const lenient = quorumDraft();
      await context.operator.register({
        draft: {
          ...lenient,
          clauses: [
            {
              when: DecisionTrigger.FAILURES_AT_LEAST,
              count: 3,
              then: VerdictStatus.FAIL,
              label: '3 of the 4 checks disagreed with this response.',
            },
          ],
        },
        verificationPolicy: checksPolicy(),
        createdBy: 'alice',
        startIn: PolicyLifecycle.SHADOW,
      });
      await context.operator.promote('search_web.default', 2, goodEvidence());

      const underV2 = await context.serving.decide({
        intentId: 'intent-v2',
        toolId: TEST_TOOL_ID,
        response: BAD_RESPONSE,
        externalResults: ONE_EXTERNAL_FAIL,
        evaluatedAt: EVALUATED_AT,
      });

      expect(underV1?.settlement).toMatchObject({
        decisionPolicyVersion: 1,
        status: VerdictStatus.FAIL,
      });
      expect(underV2?.settlement).toMatchObject({
        decisionPolicyVersion: 2,
        status: VerdictStatus.PASS,
      });
    });
  });

  describe('a tool with no policy', () => {
    it('is unverified rather than failed', async () => {
      // Our gap, not a provider's. Charging them for it would be charging them
      // for our gap.
      const outcome = await context.serving.decide({
        intentId: 'intent-no-policy',
        toolId: '11111111-2222-3333-4444-555555555555',
        response: BAD_RESPONSE,
        evaluatedAt: EVALUATED_AT,
      });

      expect(outcome).toBeNull();
    });
  });
});
