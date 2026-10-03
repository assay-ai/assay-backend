/**
 * The sampling secret and budget the worker draws semantic verification
 * against.
 *
 * This is deliberately a second, narrower provider rather than registering
 * `SEMANTIC_VERIFICATION_CONFIG` / `SemanticVerificationService`
 * (`../services/semantic-verification.service.ts`). That service is bound to
 * `SEMANTIC_JUDGE`, and no `SemanticJudgePort` implementation exists yet — no
 * model client to inject, and providing the service anyway would turn a
 * missing adapter into a boot failure of every process that imports this
 * module, for a class nothing calls. `VerificationSettlementService` instead
 * drives the sampling **domain** functions directly (`deriveSampleRate`,
 * `decideSampling`, `describeSampleRate`), and this is the config that feeds
 * them — the same two numbers `SemanticVerificationConfig` carries
 * (`samplingSecret`, `budget`), so the day a real judge is bound, wiring
 * `SemanticVerificationService` alongside this is a value, not a redesign.
 *
 * ## Failing closed with no secret configured
 *
 * `secret` is `null` when `VERIFICATION_SAMPLING_SECRET` is unset. The
 * alternative — falling back to some default string — would make the draw
 * *insecure* rather than *absent*: `decideSampling`'s whole safety property
 * is that the selector is unpredictable without the key
 * (`../domain/sampling.ts` §"Selection is keyed, not random"), and a
 * well-known default satisfies every property of a real secret except that
 * one, which is the one that matters. So an operator who has not set a
 * secret gets sampling turned *off* — every call records `NOT_SAMPLED` — not
 * a platform that silently drew against a public key.
 *
 * This does not fail boot, and today it costs nothing: no `SEMANTIC_JUDGE`
 * is bound, so a call that *was* selected would only ever produce
 * `NOT_IMPLEMENTED` rather than an actual judgement (see
 * `VerificationSettlementService.semanticJudgementFor`). A platform that has
 * not opted into sampling yet is not missing anything by defaulting to "off".
 */

import { ConfigService } from '@nestjs/config';

import { DEFAULT_VERIFICATION_BUDGET, VerificationBudget } from '../domain';

export interface VerificationSamplingConfig {
  /** `null` disables sampling — every draw records `NOT_SAMPLED`. */
  readonly secret: string | null;
  readonly budget: VerificationBudget;
}

/** DI token for {@link VerificationSamplingConfig}. */
export const VERIFICATION_SAMPLING_CONFIG = 'VERIFICATION_SAMPLING_CONFIG';

export function verificationSamplingConfigFactory(
  configService: ConfigService,
): VerificationSamplingConfig {
  const secret = configService.get<string>('VERIFICATION_SAMPLING_SECRET');

  const ratioOfFee = configService.get<string>('VERIFICATION_SEMANTIC_RATIO_OF_FEE');
  const semanticCostUsd = configService.get<string>('VERIFICATION_SEMANTIC_COST_USD');

  return {
    secret: secret && secret.length > 0 ? secret : null,
    budget: {
      ratioOfFee: ratioOfFee ? Number(ratioOfFee) : DEFAULT_VERIFICATION_BUDGET.ratioOfFee,
      semanticCostUsd: semanticCostUsd
        ? Number(semanticCostUsd)
        : DEFAULT_VERIFICATION_BUDGET.semanticCostUsd,
    },
  };
}
