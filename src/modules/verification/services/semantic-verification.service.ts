/**
 * Deciding whether to spend, spending, and refusing to record.
 *
 * This is the impure half of the semantic stage. It does four things and hands
 * the result to the pure engine as a value:
 *
 * ```text
 * 1. derive the rate   from the platform fee and the verification budget
 * 2. draw              HMAC(secret, intentId) — keyed, uniform, reproducible
 * 3. judge             one model call, bounded by a deadline we enforce
 * 4. seal              refuse anything that could not be re-derived later
 * ```
 *
 * Step 4 is the one worth being careful about. A judgement that arrives without
 * a pinned model id, or with scores outside `0..1`, is **not recorded** —
 * `sealSemanticContext` throws and this service turns that into
 * {@link SemanticOutcome.UNAVAILABLE}, which credits the provider. Refusing to
 * record is not the same as failing the provider, and the difference is the
 * whole point of the verdict rules: *the default is to pay*, and our own inability to produce defensible evidence is not evidence
 * against anyone.
 *
 * Nothing here has a caller yet. An asynchronous worker would run the cheap
 * stages, call this, and feed the judgement into `verify()`.
 */

import { Money } from '@modules/chains/ports/money.types';
import { JsonValue } from '@modules/tool/domain/mapping/mapping.types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SampleRate,
  SampleRateOverride,
  SamplingDecision,
  SemanticJudgement,
  SemanticOutcome,
  SemanticScores,
  VerificationBudget,
  decideSampling,
  deriveSampleRate,
  renderSemanticPrompt,
  sealSemanticContext,
  usdFromMoney,
} from '../domain';
import {
  SEMANTIC_JUDGE,
  SemanticJudgePort,
  SemanticJudgeResponse,
} from '../ports/semantic-judge.port';

export interface SemanticVerificationConfig {
  /**
   * The key the sampling draw is taken with. Never derived from anything a
   * provider can see, and never logged.
   */
  readonly samplingSecret: string;
  readonly budget: VerificationBudget;
  /** How long a judgement may take before the deterministic result stands. */
  readonly timeoutMs: number;
  readonly maxInputChars: number;
}

/** DI token for {@link SemanticVerificationConfig}. */
export const SEMANTIC_VERIFICATION_CONFIG = 'SEMANTIC_VERIFICATION_CONFIG';

export interface SampleRateQuery {
  /** The platform fee on the call, which is what the budget is a share of. */
  readonly platformFee: Money;
  readonly overrides?: readonly SampleRateOverride[];
}

export interface SemanticJudgeInput extends SampleRateQuery {
  /** The call. Also the sampling draw's input, so one call draws once. */
  readonly intentId: string;
  readonly request?: JsonValue;
  /** The response **after** the binding's response mapping. */
  readonly response: JsonValue;
}

/** Stable codes. Metrics group by these, so they carry no ids or values. */
const REASON_TIMEOUT = 'semantic_timeout';
const REASON_PROVIDER_ERROR = 'semantic_provider_error';
const REASON_CONTEXT_INCOMPLETE = 'semantic_context_incomplete';
const REASON_SCORES_INVALID = 'semantic_scores_invalid';

@Injectable()
export class SemanticVerificationService {
  private readonly logger = new Logger(SemanticVerificationService.name);

  constructor(
    @Inject(SEMANTIC_JUDGE) private readonly judgePort: SemanticJudgePort,
    @Inject(SEMANTIC_VERIFICATION_CONFIG) private readonly config: SemanticVerificationConfig,
  ) {}

  /**
   * The rate for a call at this price, without judging anything.
   *
   * Public because the rate is a **published** fact: the MCP tool
   * listing and the receipt both need to say "1 in 125 calls at this price"
   * before any verdict exists, and a surface that recomputed it from its own
   * copy of the constants would eventually disagree with the verdict that
   * follows.
   */
  sampleRateFor(query: SampleRateQuery): SampleRate {
    return deriveSampleRate({
      platformFeeUsd: usdFromMoney(query.platformFee),
      budget: this.config.budget,
      overrides: query.overrides,
    });
  }

  /**
   * Draw, and judge if drawn.
   *
   * Never throws for an unusable judgement — every failure mode returns
   * `UNAVAILABLE`, because a thrown error at this point would either abort a
   * verification that had already passed its cheap stages or, worse, be caught
   * upstream and turned into a failure the provider pays for.
   */
  async judge(input: SemanticJudgeInput): Promise<SemanticJudgement> {
    const sampling = decideSampling({
      secret: this.config.samplingSecret,
      intentId: input.intentId,
      rate: this.sampleRateFor(input),
    });

    if (!sampling.sampled) {
      return this.unjudged(SemanticOutcome.NOT_SAMPLED, sampling, null);
    }

    const prompt = renderSemanticPrompt({
      request: input.request,
      response: input.response,
      maxInputChars: this.config.maxInputChars,
    });

    let response: SemanticJudgeResponse;
    try {
      response = await this.withDeadline(
        this.judgePort.judge({
          prompt: prompt.text,
          temperature: 0,
          maxInputChars: prompt.maxInputChars,
          timeoutMs: this.config.timeoutMs,
        }),
      );
    } catch (error) {
      const reason = error === TIMEOUT ? REASON_TIMEOUT : REASON_PROVIDER_ERROR;
      this.logger.warn(
        `Semantic judgement unavailable for ${input.intentId}: ${reason}` +
          `${error instanceof Error ? ` — ${error.message}` : ''}`,
      );
      return this.unjudged(SemanticOutcome.UNAVAILABLE, sampling, reason);
    }

    const scores = readScores(response);
    if (!scores) {
      // A model that answered outside the contract has told us nothing usable.
      // Treating a malformed reply as a low score would strike a provider for
      // our own parsing problem.
      this.logger.warn(`Semantic judgement for ${input.intentId}: ${REASON_SCORES_INVALID}`);
      return this.unjudged(SemanticOutcome.UNAVAILABLE, sampling, REASON_SCORES_INVALID);
    }

    try {
      const context = sealSemanticContext({
        modelId: response.modelId,
        promptVersion: prompt.version,
        promptHash: prompt.hash,
        temperature: 0,
        maxInputChars: prompt.maxInputChars,
      });

      return {
        outcome: SemanticOutcome.JUDGED,
        sampling,
        scores,
        context,
        costUsd: this.config.budget.semanticCostUsd,
        unavailableReason: null,
      };
    } catch (error) {
      // The judgement happened and cannot be defended, so it is not recorded.
      // This is the loud version of a silent corruption: an operator sees the
      // model id that failed the pin, and the provider is credited meanwhile.
      this.logger.error(
        `Refusing to record a semantic judgement for ${input.intentId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return this.unjudged(SemanticOutcome.UNAVAILABLE, sampling, REASON_CONTEXT_INCOMPLETE);
    }
  }

  /**
   * A judgement with no judgement in it.
   *
   * Costs zero in every case, including the refused one: the money was spent,
   * but a verdict's `costUsd` is what the platform may attribute to *this
   * verdict's evidence*, and there is no evidence here. Model spend that
   * produced nothing is an operations metric, not a line on a receipt.
   */
  private unjudged(
    outcome: SemanticOutcome,
    sampling: SamplingDecision,
    unavailableReason: string | null,
  ): SemanticJudgement {
    return {
      outcome,
      sampling,
      scores: null,
      context: null,
      costUsd: 0,
      unavailableReason,
    };
  }

  /**
   * Our own deadline, independent of the client's.
   *
   * The semantic stage has a 5s timeout, and the deterministic result stands when it blows. That
   * promise cannot rest on the model client honouring its own timeout — the
   * failure mode being defended against is precisely a client that hangs.
   */
  private withDeadline<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(TIMEOUT), this.config.timeoutMs);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

/** A sentinel, so a timeout is distinguishable from a client error by identity. */
const TIMEOUT = Symbol('semantic-judge-timeout');

/**
 * The model's reply, validated into {@link SemanticScores} — or `null`.
 *
 * Every axis must be a finite number in `0..1`. A model is free to be wrong;
 * it is not free to be unparseable, and the difference matters because one of
 * those two can cost a provider money and the other must not.
 */
function readScores(response: SemanticJudgeResponse): SemanticScores | null {
  if (
    !inUnitInterval(response.relevance) ||
    !inUnitInterval(response.completeness) ||
    !inUnitInterval(response.coherence) ||
    typeof response.requestInScope !== 'boolean'
  ) {
    return null;
  }

  return {
    relevance: response.relevance,
    completeness: response.completeness,
    coherence: response.coherence,
    requestInScope: response.requestInScope,
    reason: typeof response.reason === 'string' ? response.reason : null,
  };
}

function inUnitInterval(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
