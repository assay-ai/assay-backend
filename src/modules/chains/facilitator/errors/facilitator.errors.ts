import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `FACILITATOR_*` — failures of the facilitator *process itself*, not verdicts
 * about a payment.
 *
 * A payload that fails one of the six `exact`-SVM rules is not an error: it is
 * a normal `{ isValid: false, invalidReason }` (verify) or
 * `{ success: false, errorReason }` (settle) — both 200s, per
 * `facilitator.wire.ts`. These codes exist for the other case: the facilitator
 * could not even attempt an answer, because its fee-payer signer (Kora or the
 * local fallback) is unreachable, or because it was asked to run the local
 * fallback in production, which is never a sanctioned production path.
 */
export enum FacilitatorErrorCode {
  FACILITATOR_SIGNER_UNAVAILABLE = 'FACILITATOR_SIGNER_UNAVAILABLE',
  FACILITATOR_LOCAL_SIGNER_FORBIDDEN_IN_PRODUCTION = 'FACILITATOR_LOCAL_SIGNER_FORBIDDEN_IN_PRODUCTION',
}

export type FacilitatorErrorCodesArePrefixed = AssertDomainErrorCodes<
  'FACILITATOR',
  `${FacilitatorErrorCode}`
>;

export const FacilitatorErrors = createDomainErrorFactory('FACILITATOR', {
  signerUnavailable: {
    code: FacilitatorErrorCode.FACILITATOR_SIGNER_UNAVAILABLE,
    // `503`, never `502`: see `edgeSafeStatus`.
    statusCode: 503,
    message: (context?: Record<string, any>) =>
      `Fee-payer signer "${context?.signer ?? 'unknown'}" is unavailable` +
      `${context?.reason ? `: ${context.reason}` : ''}`,
  },
  localSignerForbiddenInProduction: {
    code: FacilitatorErrorCode.FACILITATOR_LOCAL_SIGNER_FORBIDDEN_IN_PRODUCTION,
    statusCode: 500,
    message: () =>
      'FEE_PAYER_SIGNER=local refuses to start with NODE_ENV=production — it holds the fee-payer ' +
      'key in this process instead of behind Kora/KMS. Set FEE_PAYER_SIGNER=kora.',
  },
});
