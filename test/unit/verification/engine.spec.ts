import { JsonSchema } from '@modules/tool/domain/mapping/schema-validator';
import {
  ConditionOperator,
  EmptyResultDisposition,
  PolicyMode,
  STAGE_STATUS_LABEL,
  StageStatus,
  VERIFICATION_PIPELINE,
  VerdictStatus,
  VerificationPolicy,
  VerificationRuleType,
  VerificationStage,
  effectiveConsequence,
  isStagePass,
  stageRan,
  verify,
  VERDICT_CONSEQUENCE,
} from '@modules/verification/domain';

/**
 * The pipeline as a whole: ordering, early exit, and what the receipt
 * is allowed to say about the stages that never ran.
 *
 * The branch suites next door prove each stage in isolation. This one proves
 * the two properties that only exist once they are composed — *the cheap layers
 * run on every call* and *checking stops at the first failure and says so*.
 */

const EVALUATED_AT = new Date('2026-08-15T10:00:00.000Z');

/**
 * A search-shaped contract, deliberately **without** `minItems`.
 *
 * An empty result set has to reach the deterministic stage to be judged by the
 * empty-result policy. A `minItems: 1` here would fail it at the schema stage
 * instead, which is the false positive the verdict vocabulary exists to prevent — so the tool
 * contract states the shape and leaves "how many is enough" to the policy,
 * where it can be gated, weighted and corroborated.
 */
const SEARCH_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
        },
      },
    },
    totalResults: { type: 'integer' },
  },
};

function policy(overrides: Partial<VerificationPolicy> = {}): VerificationPolicy {
  return {
    id: 'vp_search_web',
    toolId: 'search_web',
    version: 3,
    rules: [
      {
        id: 'min_results',
        type: VerificationRuleType.MIN_ARRAY_LENGTH,
        path: '$.results',
        min: 1,
        weight: 0.5,
      },
      {
        id: 'urls_valid',
        type: VerificationRuleType.VALID_URL,
        path: '$.results[*].url',
        weight: 0.5,
      },
    ],
    passThreshold: 0.7,
    mode: PolicyMode.ACTIVE,
    ...overrides,
  };
}

function run(response: unknown, overrides: Partial<VerificationPolicy> = {}) {
  return verify({
    intentId: 'pi_01J8XZQ4M7K2N9P3R5T7V9W1Y3',
    policy: policy(overrides),
    outputSchema: SEARCH_SCHEMA,
    response: response as never,
    evaluatedAt: EVALUATED_AT,
  });
}

const GOOD = { results: [{ url: 'https://example.com/a', title: 'A' }] };
/** Schema-valid — `url` is a string — and rejected by the URL rule. */
const BAD_URL = { results: [{ url: 'not a url', title: 'A' }] };
/** `results` is not an array at all: a provable contract violation. */
const WRONG_SHAPE = { results: 'nope' };

function stage(verdict: ReturnType<typeof run>, which: VerificationStage) {
  const found = verdict.stages.find((result) => result.stage === which);
  if (!found) throw new Error(`no result for stage ${which}`);
  return found;
}

describe('verification engine', () => {
  describe('every stage is accounted for, always', () => {
    it.each([
      ['a passing call', GOOD],
      ['a rules failure', BAD_URL],
      ['a schema failure', WRONG_SHAPE],
      ['an empty result', { results: [] }],
    ])('emits one result per pipeline stage, in order — %s', (_label, response) => {
      const verdict = run(response);
      expect(verdict.stages.map((result) => result.stage)).toEqual(VERIFICATION_PIPELINE);
    });
  });

  describe('checking stops at the first stage that does not pass', () => {
    it('records the later stages as not reached, never as passed — schema failure', () => {
      const verdict = run(WRONG_SHAPE);

      expect(verdict.status).toBe(VerdictStatus.FAIL);
      expect(stage(verdict, VerificationStage.SCHEMA).status).toBe(StageStatus.FAILED);

      for (const later of [
        VerificationStage.DETERMINISTIC_RULES,
        VerificationStage.CROSS_CHECK,
        VerificationStage.SEMANTIC,
      ]) {
        const result = stage(verdict, later);
        expect(result.status).toBe(StageStatus.NOT_REACHED);
        // The three assertions that matter to a reader of the receipt.
        expect(isStagePass(result.status)).toBe(false);
        expect(STAGE_STATUS_LABEL[result.status]).toBe('not reached');
        expect(result.score).toBeNull();
      }
    });

    it('records the later stages as not reached — deterministic-rules failure', () => {
      const verdict = run(BAD_URL);

      expect(verdict.status).toBe(VerdictStatus.FAIL);
      // The stage before the failure is a genuine pass, and says so.
      expect(stage(verdict, VerificationStage.SCHEMA).status).toBe(StageStatus.PASSED);
      expect(stage(verdict, VerificationStage.DETERMINISTIC_RULES).status).toBe(StageStatus.FAILED);

      for (const later of [VerificationStage.CROSS_CHECK, VerificationStage.SEMANTIC]) {
        expect(stage(verdict, later).status).toBe(StageStatus.NOT_REACHED);
      }
    });

    it('never marks a stage after the failing one as passed, whatever failed', () => {
      for (const response of [WRONG_SHAPE, BAD_URL]) {
        const verdict = run(response, {
          crossCheck: { enabled: true },
          semantic: { enabled: true },
        });
        const failedAt = verdict.stages.findIndex((result) => !isStagePass(result.status));

        expect(failedAt).toBeGreaterThanOrEqual(0);
        for (const later of verdict.stages.slice(failedAt + 1)) {
          expect(later.status).toBe(StageStatus.NOT_REACHED);
          expect(isStagePass(later.status)).toBe(false);
          // A declared-but-unbuilt stage must not sneak in behind a failure
          // either: after a failure nothing is known about it, including that
          // it is unimplemented.
          expect(later.status).not.toBe(StageStatus.NOT_IMPLEMENTED);
        }
      }
    });

    it('reports the failure of the stage that decided it, not of an earlier inapplicable one', () => {
      // No schema anywhere, so stage 1 is NOT_APPLICABLE — which is not a pass,
      // and must still not become the receipt's headline when a later stage is
      // what actually failed.
      const verdict = verify({
        intentId: 'pi_no_schema',
        policy: policy(),
        response: BAD_URL as never,
        evaluatedAt: EVALUATED_AT,
      });

      expect(stage(verdict, VerificationStage.SCHEMA).status).toBe(StageStatus.NOT_APPLICABLE);
      expect(verdict.status).toBe(VerdictStatus.FAIL);
      expect(verdict.reasonCode).toBe(stage(verdict, VerificationStage.DETERMINISTIC_RULES).code);
    });
  });

  describe('the cheap stages run on every call — there is no sampler', () => {
    it('runs both on a policy that declares a sampled semantic stage', () => {
      const verdict = run(GOOD, { semantic: { enabled: true } });

      expect(stageRan(stage(verdict, VerificationStage.SCHEMA).status)).toBe(true);
      expect(stageRan(stage(verdict, VerificationStage.DETERMINISTIC_RULES).status)).toBe(true);
      expect(verdict.sampled).toBe(false);
    });

    it('runs both on 200 consecutive calls without skipping one', () => {
      for (let call = 0; call < 200; call += 1) {
        const verdict = run({
          results: [{ url: `https://example.com/${call}`, title: `result ${call}` }],
        });
        expect(stageRan(stage(verdict, VerificationStage.SCHEMA).status)).toBe(true);
        expect(stageRan(stage(verdict, VerificationStage.DETERMINISTIC_RULES).status)).toBe(true);
        expect(verdict.status).toBe(VerdictStatus.PASS);
      }
    });
  });

  describe('the stages that do not exist yet', () => {
    it('are not applicable when the policy never declared them', () => {
      const verdict = run(GOOD);
      expect(stage(verdict, VerificationStage.CROSS_CHECK).status).toBe(StageStatus.NOT_APPLICABLE);
      expect(stage(verdict, VerificationStage.SEMANTIC).status).toBe(StageStatus.NOT_APPLICABLE);
    });

    it('are not implemented — and never passed — when the policy did declare them', () => {
      const verdict = run(GOOD, { crossCheck: { enabled: true }, semantic: { enabled: true } });

      for (const declared of [VerificationStage.CROSS_CHECK, VerificationStage.SEMANTIC]) {
        const result = stage(verdict, declared);
        expect(result.status).toBe(StageStatus.NOT_IMPLEMENTED);
        expect(isStagePass(result.status)).toBe(false);
        expect(result.score).toBeNull();
      }
      // The cheap layers still passed, so the verdict pays — but the receipt
      // shows exactly which layers that judgement rests on.
      expect(verdict.status).toBe(VerdictStatus.PASS);
    });
  });

  describe('a legitimately empty result is not a failure', () => {
    it('passes unconfirmed when the policy says nothing about empties', () => {
      const verdict = run({ results: [], totalResults: 0 });

      expect(verdict.status).toBe(VerdictStatus.EMPTY_UNVERIFIED);
      expect(verdict.status).not.toBe(VerdictStatus.FAIL);
      expect(VERDICT_CONSEQUENCE[verdict.status].strike).toBe(false);
      // Early exit applies to a passing decision too: there is nothing in an
      // empty result for a model to judge.
      expect(stage(verdict, VerificationStage.SEMANTIC).status).toBe(StageStatus.NOT_REACHED);
    });

    it('passes confirmed when the response itself corroborates the emptiness', () => {
      const verdict = run(
        { results: [], totalResults: 0 },
        {
          emptyResult: {
            evidence: [{ path: '$.totalResults', operator: ConditionOperator.EQUALS, value: 0 }],
          },
        },
      );

      expect(verdict.status).toBe(VerdictStatus.EMPTY_CONFIRMED);
      expect(VERDICT_CONSEQUENCE[verdict.status].settle).toBe(true);
      expect(VERDICT_CONSEQUENCE[verdict.status].strike).toBe(false);
    });

    it('fails only where the policy declares an empty answer impossible', () => {
      const verdict = run(
        { results: [] },
        { emptyResult: { whenUncorroborated: EmptyResultDisposition.FAIL } },
      );
      expect(verdict.status).toBe(VerdictStatus.FAIL);
    });
  });

  describe('the verdict a receipt is built from', () => {
    it('carries no reason on a pass', () => {
      const verdict = run(GOOD);
      expect(verdict.status).toBe(VerdictStatus.PASS);
      expect(verdict.reasonCode).toBeNull();
      expect(verdict.reason).toBeNull();
    });

    it('carries the policy identity and the injected clock', () => {
      const verdict = run(GOOD);
      expect(verdict.policyId).toBe('vp_search_web');
      expect(verdict.policyVersion).toBe(3);
      expect(verdict.evaluatedAt).toBe(EVALUATED_AT);
      expect(verdict.costUsd).toBe(0);
    });

    it("reports the deciding stage's score rather than an average", () => {
      const verdict = run(BAD_URL);
      // One of two equally weighted rules failed.
      expect(verdict.score).toBeCloseTo(0.5, 4);
      expect(verdict.score).toBeLessThan(policy().passThreshold);
    });

    it('reports no score at all when nothing scored', () => {
      const verdict = verify({
        intentId: 'pi_unscored',
        policy: policy({ rules: [] }),
        response: GOOD as never,
        evaluatedAt: EVALUATED_AT,
      });
      // No schema and no rules: stage 1 inapplicable, stage 2 vacuously fine.
      // `null` rather than `0` — nothing was judged, so nothing scored badly.
      expect(stage(verdict, VerificationStage.SCHEMA).score).toBeNull();
      expect(verdict.status).toBe(VerdictStatus.PASS);
    });
  });

  describe('shadow mode', () => {
    it('computes the same verdict and strips its economic effect', () => {
      const active = run(BAD_URL);
      const shadow = run(BAD_URL, { mode: PolicyMode.SHADOW });

      expect(shadow.status).toBe(active.status);
      expect(shadow.shadow).toBe(true);
      expect(effectiveConsequence(active).strike).toBe(true);
      expect(effectiveConsequence(shadow).strike).toBe(false);
      expect(effectiveConsequence(shadow).settle).toBe(true);
    });
  });

  describe('purity', () => {
    it('produces an identical verdict for identical inputs', () => {
      const first = run(BAD_URL);
      const second = run(BAD_URL);
      expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
    });
  });
});
