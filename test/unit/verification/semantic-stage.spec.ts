import { JsonSchema } from '@modules/tool/domain/mapping/schema-validator';
import {
  DEFAULT_VERIFICATION_BUDGET,
  PolicyMode,
  SemanticContext,
  SemanticJudgement,
  SemanticOutcome,
  SemanticScores,
  StageStatus,
  VERDICT_CONSEQUENCE,
  VerdictStatus,
  VerificationPolicy,
  VerificationRuleType,
  VerificationStage,
  decideSampling,
  deriveSampleRate,
  describeSampleRate,
  isStagePass,
  verify,
} from '@modules/verification/domain';
import { VerificationErrorCode } from '@modules/verification/errors/verification.errors';
import { BaseError } from '@shared/errors/base.error';

/**
 * The semantic stage, through the engine that runs it.
 *
 * Everything here is about *who pays for what nobody could see*. Three of the
 * five outcomes below credit the provider — not sampled, unavailable, and
 * out-of-scope — and each one is a case where the response might well have been
 * bad and we cannot say so with evidence. The rule is plain: **the default is
 * to pay**, and not paying
 * requires positive evidence of failure.
 */

const EVALUATED_AT = new Date('2026-08-16T10:00:00.000Z');
const SECRET = 'test-sampling-secret';

const SEARCH_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['results'],
  properties: {
    results: { type: 'array', items: { type: 'object' } },
  },
};

const RESPONSE = { results: [{ url: 'https://example.com/a', title: 'USDC price' }] };
const REQUEST = { query: 'usdc price' };

const CONTEXT: SemanticContext = Object.freeze({
  modelId: 'claude-haiku-4-5-20251001',
  promptVersion: 1,
  promptHash: 'b'.repeat(64),
  temperature: 0,
  maxInputChars: 8_000,
});

/** The rate on a $0.001 call: 1 in 125. */
const CHEAP_RATE = deriveSampleRate({
  platformFeeUsd: 0.0001,
  budget: DEFAULT_VERIFICATION_BUDGET,
});

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
        weight: 1,
      },
    ],
    passThreshold: 0.7,
    mode: PolicyMode.ACTIVE,
    semantic: { enabled: true },
    ...overrides,
  };
}

function scores(overrides: Partial<SemanticScores> = {}): SemanticScores {
  return {
    relevance: 0.9,
    completeness: 0.9,
    coherence: 0.9,
    requestInScope: true,
    reason: 'Addresses the query with a usable result.',
    ...overrides,
  };
}

/** A judgement that was sampled and came back. */
function judged(overrides: Partial<SemanticJudgement> = {}): SemanticJudgement {
  return {
    outcome: SemanticOutcome.JUDGED,
    // `pi_sampled_1` is below the 100% rate used here, so `sampled` is true.
    sampling: decideSampling({
      secret: SECRET,
      intentId: 'pi_1',
      rate: deriveSampleRate({ platformFeeUsd: 1 }),
    }),
    scores: scores(),
    context: CONTEXT,
    costUsd: 0.0025,
    unavailableReason: null,
    ...overrides,
  };
}

function notSampled(): SemanticJudgement {
  return {
    outcome: SemanticOutcome.NOT_SAMPLED,
    sampling: { sampled: false, rate: CHEAP_RATE, selector: 0.5 },
    scores: null,
    context: null,
    costUsd: 0,
    unavailableReason: null,
  };
}

function run(input: {
  policy?: VerificationPolicy;
  response?: unknown;
  semantic?: SemanticJudgement;
}) {
  return verify({
    intentId: 'pi_1',
    policy: input.policy ?? policy(),
    outputSchema: SEARCH_SCHEMA,
    response: (input.response ?? RESPONSE) as never,
    request: REQUEST as never,
    semantic: input.semantic,
    evaluatedAt: EVALUATED_AT,
  });
}

function semanticRow(verdict: ReturnType<typeof run>) {
  return verdict.stages.find((stage) => stage.stage === VerificationStage.SEMANTIC)!;
}

describe('semantic stage — when it does not run', () => {
  it('is NOT_APPLICABLE for a policy that never declared it', () => {
    const verdict = run({ policy: policy({ semantic: undefined }), semantic: judged() });

    expect(semanticRow(verdict).status).toBe(StageStatus.NOT_APPLICABLE);
    expect(verdict.status).toBe(VerdictStatus.PASS);
    expect(verdict.sampled).toBe(false);
    expect(verdict.sampleRate).toBeNull();
    expect(verdict.semanticContext).toBeNull();
    expect(verdict.costUsd).toBe(0);
  });

  it('is NOT_IMPLEMENTED when the policy declares it and no judgement was supplied', () => {
    const verdict = run({ semantic: undefined });

    expect(semanticRow(verdict).status).toBe(StageStatus.NOT_IMPLEMENTED);
    expect(verdict.status).toBe(VerdictStatus.PASS);
    expect(verdict.sampled).toBe(false);
  });

  it('is NOT_REACHED when a cheap stage already failed, and costs nothing', () => {
    const verdict = run({ response: { results: 'not an array' }, semantic: judged() });

    expect(semanticRow(verdict).status).toBe(StageStatus.NOT_REACHED);
    // A judgement was handed in, and the pipeline never got there. Neither the
    // cost nor the sampling flag may leak onto a verdict decided at stage 1.
    expect(verdict.sampled).toBe(false);
    expect(verdict.costUsd).toBe(0);
    expect(verdict.semanticContext).toBeNull();
  });
});

describe('semantic stage — not sampled', () => {
  it('records SKIPPED and publishes the rate that was not drawn', () => {
    const verdict = run({ semantic: notSampled() });
    const row = semanticRow(verdict);

    expect(row.status).toBe(StageStatus.SKIPPED);
    expect(isStagePass(row.status)).toBe(false);
    expect(row.score).toBeNull();
    expect(row.detail).toBe(describeSampleRate(CHEAP_RATE));
    expect(row.detail).toBe('1 in 125 calls at this price');
  });

  it('settles as SKIPPED, which credits the provider', () => {
    const verdict = run({ semantic: notSampled() });

    expect(verdict.status).toBe(VerdictStatus.SKIPPED);
    expect(VERDICT_CONSEQUENCE[verdict.status].settle).toBe(true);
    expect(VERDICT_CONSEQUENCE[verdict.status].strike).toBe(false);
    expect(verdict.sampled).toBe(false);
    expect(verdict.costUsd).toBe(0);
  });

  it('carries the sample rate onto the verdict, for the receipt', () => {
    const verdict = run({ semantic: notSampled() });

    expect(verdict.sampleRate).toEqual(CHEAP_RATE);
    expect(verdict.sampleRate?.oneIn).toBe(125);
  });
});

describe('semantic stage — unavailable', () => {
  it('records the stage as UNAVAILABLE and settles DEGRADED', () => {
    const verdict = run({
      semantic: judged({
        outcome: SemanticOutcome.UNAVAILABLE,
        scores: null,
        context: null,
        costUsd: 0,
        unavailableReason: 'semantic_timeout',
      }),
    });
    const row = semanticRow(verdict);

    expect(row.status).toBe(StageStatus.UNAVAILABLE);
    expect(row.code).toBe('semantic_timeout');
    expect(row.score).toBeNull();
    expect(verdict.status).toBe(VerdictStatus.DEGRADED);
  });

  it('never costs the provider anything — our outage is not their loss', () => {
    const verdict = run({
      semantic: judged({
        outcome: SemanticOutcome.UNAVAILABLE,
        scores: null,
        context: null,
        unavailableReason: 'semantic_timeout',
      }),
    });

    expect(VERDICT_CONSEQUENCE[verdict.status].settle).toBe(true);
    expect(VERDICT_CONSEQUENCE[verdict.status].strike).toBe(false);
    expect(VERDICT_CONSEQUENCE[verdict.status].slashable).toBe(false);
  });
});

describe('semantic stage — judged', () => {
  it('passes a relevant, complete, coherent response and scores the mean', () => {
    const verdict = run({ semantic: judged() });
    const row = semanticRow(verdict);

    expect(row.status).toBe(StageStatus.PASSED);
    expect(row.score).toBeCloseTo(0.9, 10);
    expect(verdict.status).toBe(VerdictStatus.PASS);
    expect(verdict.score).toBeCloseTo(0.9, 10);
  });

  it('marks the verdict sampled and charges what the judgement cost', () => {
    const verdict = run({ semantic: judged() });

    expect(verdict.sampled).toBe(true);
    expect(verdict.costUsd).toBe(0.0025);
  });

  it('pins the model and the prompt onto the verdict', () => {
    const verdict = run({ semantic: judged() });

    expect(verdict.semanticContext).toEqual(CONTEXT);
  });

  it('fails a response the model found irrelevant', () => {
    const verdict = run({ semantic: judged({ scores: scores({ relevance: 0.2 }) }) });
    const row = semanticRow(verdict);

    expect(row.status).toBe(StageStatus.FAILED);
    expect(row.code).toBe('irrelevant_response');
    expect(row.detail).toContain('Addresses the query');
    expect(verdict.status).toBe(VerdictStatus.FAIL);
    expect(VERDICT_CONSEQUENCE[verdict.status].strike).toBe(true);
  });

  it("calls it MISAPPLIED, not FAIL, when the request was out of the tool's scope", () => {
    const verdict = run({
      semantic: judged({ scores: scores({ relevance: 0.1, requestInScope: false }) }),
    });
    const row = semanticRow(verdict);

    expect(row.status).toBe(StageStatus.MISAPPLIED);
    expect(row.code).toBe('request_out_of_scope');
    expect(verdict.status).toBe(VerdictStatus.MISAPPLIED);
    // The provider answered the question it was given. Nobody is struck.
    expect(VERDICT_CONSEQUENCE[verdict.status].strike).toBe(false);
    expect(VERDICT_CONSEQUENCE[verdict.status].settle).toBe(false);
  });

  it('passes an in-scope answer that scored well even if the model flagged scope', () => {
    const verdict = run({ semantic: judged({ scores: scores({ requestInScope: false }) }) });

    expect(semanticRow(verdict).status).toBe(StageStatus.PASSED);
    expect(verdict.status).toBe(VerdictStatus.PASS);
  });

  it('honours the policy threshold rather than the default', () => {
    const lenient = run({
      policy: policy({ semantic: { enabled: true, minRelevance: 0.2 } }),
      semantic: judged({ scores: scores({ relevance: 0.3 }) }),
    });
    const strict = run({
      policy: policy({ semantic: { enabled: true, minRelevance: 0.95 } }),
      semantic: judged({ scores: scores({ relevance: 0.9 }) }),
    });

    expect(lenient.status).toBe(VerdictStatus.PASS);
    expect(strict.status).toBe(VerdictStatus.FAIL);
  });

  it('gates completeness and coherence only when the policy asks', () => {
    const ungated = run({ semantic: judged({ scores: scores({ completeness: 0.1 }) }) });
    const gated = run({
      policy: policy({ semantic: { enabled: true, minCompleteness: 0.5 } }),
      semantic: judged({ scores: scores({ completeness: 0.1 }) }),
    });

    expect(ungated.status).toBe(VerdictStatus.PASS);
    expect(gated.status).toBe(VerdictStatus.FAIL);
    expect(semanticRow(gated).code).toBe('incomplete_response');
  });

  it('refuses to record a judgement with no sealed context', () => {
    let thrown: BaseError | undefined;
    try {
      run({ semantic: judged({ context: null }) });
    } catch (error) {
      thrown = error as BaseError;
    }

    expect(thrown?.errorCode).toBe(VerificationErrorCode.VERIFICATION_SEMANTIC_CONTEXT_INCOMPLETE);
  });

  it('refuses to record a judgement whose model id is not pinned', () => {
    let thrown: BaseError | undefined;
    try {
      run({
        semantic: judged({
          context: { ...CONTEXT, modelId: 'claude-haiku-latest' } as SemanticContext,
        }),
      });
    } catch (error) {
      thrown = error as BaseError;
    }

    expect(thrown?.errorCode).toBe(VerificationErrorCode.VERIFICATION_SEMANTIC_CONTEXT_INCOMPLETE);
  });

  it('refuses to record a judgement with no prompt version', () => {
    let thrown: BaseError | undefined;
    try {
      run({
        semantic: judged({
          context: { ...CONTEXT, promptVersion: undefined } as unknown as SemanticContext,
        }),
      });
    } catch (error) {
      thrown = error as BaseError;
    }

    expect(thrown?.errorCode).toBe(VerificationErrorCode.VERIFICATION_SEMANTIC_CONTEXT_INCOMPLETE);
  });

  it('a shadow policy still computes the verdict and still cannot act on it', () => {
    const verdict = run({
      policy: policy({ mode: PolicyMode.SHADOW }),
      semantic: judged({ scores: scores({ relevance: 0.1 }) }),
    });

    expect(verdict.status).toBe(VerdictStatus.FAIL);
    expect(verdict.shadow).toBe(true);
  });
});
