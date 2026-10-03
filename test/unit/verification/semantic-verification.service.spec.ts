import { Logger } from '@nestjs/common';
import { toAssetId, toChainId } from '@modules/chains/ports/caip.types';
import {
  DEFAULT_VERIFICATION_BUDGET,
  SEMANTIC_PROMPT_VERSION,
  SampleRateOverride,
  SemanticOutcome,
  describeSampleRate,
  renderSemanticPrompt,
} from '@modules/verification/domain';
import {
  SemanticJudgePort,
  SemanticJudgeRequest,
  SemanticJudgeResponse,
} from '@modules/verification/ports/semantic-judge.port';
import {
  SemanticVerificationConfig,
  SemanticVerificationService,
} from '@modules/verification/services/semantic-verification.service';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * The impure half of the semantic stage: deciding whether to spend, spending, and refusing
 * to record what cannot be defended.
 *
 * The model provider is a port and is mocked here — a test that called a real
 * model would be non-deterministic, would cost money per run, and would prove
 * nothing about this class, whose entire job is what happens *around* the call.
 */

const USDC = toAssetId(
  toChainId('solana', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'),
  'token',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
);

/** $0.0001 — the fee on a $0.001 call. 1 in 125. */
const CHEAP_FEE = MoneyUtil.of('100', USDC, 6);
/** $1.00 of fee. Every call. */
const RICH_FEE = MoneyUtil.of('1000000', USDC, 6);

const MODEL_ID = 'claude-haiku-4-5-20251001';

const REQUEST = { query: 'usdc price' };
const RESPONSE = { results: [{ url: 'https://example.com/a', title: 'USDC' }] };

const CONFIG: SemanticVerificationConfig = {
  samplingSecret: 'test-sampling-secret',
  budget: DEFAULT_VERIFICATION_BUDGET,
  timeoutMs: 50,
  maxInputChars: 8_000,
};

class StubJudge implements SemanticJudgePort {
  readonly calls: SemanticJudgeRequest[] = [];

  constructor(
    private readonly respond: (request: SemanticJudgeRequest) => Promise<SemanticJudgeResponse>,
  ) {}

  judge(request: SemanticJudgeRequest): Promise<SemanticJudgeResponse> {
    this.calls.push(request);
    return this.respond(request);
  }
}

function goodJudge(overrides: Partial<SemanticJudgeResponse> = {}): StubJudge {
  return new StubJudge(() =>
    Promise.resolve({
      modelId: MODEL_ID,
      relevance: 0.91,
      completeness: 0.88,
      coherence: 0.95,
      requestInScope: true,
      reason: 'Answers the query.',
      ...overrides,
    }),
  );
}

function service(judge: SemanticJudgePort, config: Partial<SemanticVerificationConfig> = {}) {
  return new SemanticVerificationService(judge, { ...CONFIG, ...config });
}

/**
 * Half of this suite drives the degrade paths on purpose, and each one logs.
 * Silenced rather than tolerated: a suite whose passing output is full of
 * warnings is a suite nobody reads the output of.
 */
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

function judgeCall(overrides: Record<string, unknown> = {}) {
  return {
    intentId: 'pi_1',
    platformFee: RICH_FEE,
    request: REQUEST as never,
    response: RESPONSE as never,
    ...overrides,
  };
}

describe('SemanticVerificationService — publishing the rate', () => {
  it('derives the rate from the fee, for display before any call is made', () => {
    const rate = service(goodJudge()).sampleRateFor({ platformFee: CHEAP_FEE });

    expect(rate.oneIn).toBe(125);
    expect(describeSampleRate(rate)).toBe('1 in 125 calls at this price');
  });

  it('applies overrides to the published rate too', () => {
    const rate = service(goodJudge()).sampleRateFor({
      platformFee: CHEAP_FEE,
      overrides: [SampleRateOverride.NEW_PROVIDER],
    });

    expect(describeSampleRate(rate)).toBe('every call');
  });
});

describe('SemanticVerificationService — sampling', () => {
  it('does not call the model when the draw misses, and spends nothing', async () => {
    const judge = goodJudge();
    // 1 in 125: `pi_1`'s keyed selector is far above 0.008.
    const judgement = await service(judge).judge(judgeCall({ platformFee: CHEAP_FEE }));

    expect(judgement.outcome).toBe(SemanticOutcome.NOT_SAMPLED);
    expect(judge.calls).toHaveLength(0);
    expect(judgement.costUsd).toBe(0);
    expect(judgement.context).toBeNull();
  });

  it('publishes the rate it drew against even when it did not draw', async () => {
    const judgement = await service(goodJudge()).judge(judgeCall({ platformFee: CHEAP_FEE }));

    expect(judgement.sampling.rate.oneIn).toBe(125);
    expect(judgement.sampling.sampled).toBe(false);
  });

  it('calls the model once when the draw hits', async () => {
    const judge = goodJudge();
    const judgement = await service(judge).judge(judgeCall());

    expect(judgement.outcome).toBe(SemanticOutcome.JUDGED);
    expect(judge.calls).toHaveLength(1);
  });

  it('samples roughly one call in 125 across a few thousand intents', async () => {
    const judge = goodJudge();
    const subject = service(judge);
    const calls = 4_000;
    let sampled = 0;

    for (let index = 0; index < calls; index += 1) {
      const judgement = await subject.judge(
        judgeCall({ intentId: `pi_${index}`, platformFee: CHEAP_FEE }),
      );
      if (judgement.sampling.sampled) sampled += 1;
    }

    expect(judge.calls).toHaveLength(sampled);
    const tolerance = 4 * Math.sqrt((0.008 * 0.992) / calls);
    expect(Math.abs(sampled / calls - 0.008)).toBeLessThan(tolerance);
  });
});

describe('SemanticVerificationService — what it asks the model', () => {
  it('sends the versioned prompt at temperature 0, bounded', async () => {
    const judge = goodJudge();
    await service(judge).judge(judgeCall());

    const [sent] = judge.calls;
    expect(sent.temperature).toBe(0);
    expect(sent.maxInputChars).toBe(8_000);
    expect(sent.timeoutMs).toBe(50);
    expect(sent.prompt).toBe(
      renderSemanticPrompt({ request: REQUEST as never, response: RESPONSE as never }).text,
    );
  });

  it('seals the model and prompt onto the judgement', async () => {
    const judgement = await service(goodJudge()).judge(judgeCall());
    const rendered = renderSemanticPrompt({
      request: REQUEST as never,
      response: RESPONSE as never,
    });

    expect(judgement.context).toEqual({
      modelId: MODEL_ID,
      promptVersion: SEMANTIC_PROMPT_VERSION,
      promptHash: rendered.hash,
      temperature: 0,
      maxInputChars: 8_000,
    });
  });

  it("charges the judgement at the budget's stated cost", async () => {
    const judgement = await service(goodJudge()).judge(judgeCall());

    expect(judgement.costUsd).toBe(DEFAULT_VERIFICATION_BUDGET.semanticCostUsd);
  });
});

describe('SemanticVerificationService — determinism', () => {
  it('produces an identical judgement for identical input and model', async () => {
    const first = await service(goodJudge()).judge(judgeCall());
    const second = await service(goodJudge()).judge(judgeCall());

    expect(second).toEqual(first);
  });

  it('is insensitive to key order in the request', async () => {
    const a = await service(goodJudge()).judge(
      judgeCall({ request: { query: 'usdc price', limit: 5 } }),
    );
    const b = await service(goodJudge()).judge(
      judgeCall({ request: { limit: 5, query: 'usdc price' } }),
    );

    expect(b.context?.promptHash).toBe(a.context?.promptHash);
  });

  it('hashes a different response to a different prompt', async () => {
    const a = await service(goodJudge()).judge(judgeCall());
    const b = await service(goodJudge()).judge(judgeCall({ response: { results: [] } }));

    expect(b.context?.promptHash).not.toBe(a.context?.promptHash);
  });

  it('records the model that actually answered, not the one we hoped for', async () => {
    const judgement = await service(goodJudge({ modelId: 'claude-haiku-4-5-20260101' })).judge(
      judgeCall(),
    );

    expect(judgement.context?.modelId).toBe('claude-haiku-4-5-20260101');
  });
});

describe('SemanticVerificationService — refusing to record', () => {
  it('degrades rather than records a judgement whose model id is a floating alias', async () => {
    const judgement = await service(goodJudge({ modelId: 'claude-haiku-latest' })).judge(
      judgeCall(),
    );

    expect(judgement.outcome).toBe(SemanticOutcome.UNAVAILABLE);
    expect(judgement.unavailableReason).toBe('semantic_context_incomplete');
    expect(judgement.context).toBeNull();
    expect(judgement.scores).toBeNull();
  });

  it('degrades when the model client reports no model id at all', async () => {
    const judgement = await service(goodJudge({ modelId: '' })).judge(judgeCall());

    expect(judgement.outcome).toBe(SemanticOutcome.UNAVAILABLE);
    expect(judgement.unavailableReason).toBe('semantic_context_incomplete');
  });

  it('charges nothing for a judgement it refused to record', async () => {
    const judgement = await service(goodJudge({ modelId: 'latest' })).judge(judgeCall());

    expect(judgement.costUsd).toBe(0);
  });

  it('degrades on scores outside 0..1 rather than striking on a malformed reply', async () => {
    for (const relevance of [1.5, -0.2, Number.NaN, undefined as unknown as number]) {
      const judgement = await service(goodJudge({ relevance })).judge(judgeCall());

      expect(judgement.outcome).toBe(SemanticOutcome.UNAVAILABLE);
      expect(judgement.unavailableReason).toBe('semantic_scores_invalid');
    }
  });
});

describe('SemanticVerificationService — when the model is unavailable', () => {
  it('degrades when the client throws', async () => {
    const judge = new StubJudge(() => Promise.reject(new Error('connection reset')));
    const judgement = await service(judge).judge(judgeCall());

    expect(judgement.outcome).toBe(SemanticOutcome.UNAVAILABLE);
    expect(judgement.unavailableReason).toBe('semantic_provider_error');
    expect(judgement.costUsd).toBe(0);
  });

  it('degrades when the client outlives the timeout', async () => {
    const judge = new StubJudge(
      () => new Promise<SemanticJudgeResponse>(() => undefined), // never settles
    );
    const judgement = await service(judge, { timeoutMs: 20 }).judge(judgeCall());

    expect(judgement.outcome).toBe(SemanticOutcome.UNAVAILABLE);
    expect(judgement.unavailableReason).toBe('semantic_timeout');
  });

  it('still reports the sampling decision when it could not judge', async () => {
    const judge = new StubJudge(() => Promise.reject(new Error('nope')));
    const judgement = await service(judge).judge(judgeCall());

    expect(judgement.sampling.sampled).toBe(true);
    expect(judgement.sampling.rate.rate).toBe(1);
  });
});
