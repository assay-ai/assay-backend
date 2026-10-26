import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `VERIFICATION_*` — the layered verification engine, the aggregator, and
 * policy lifecycle including the kill switch.
 */
export enum VerificationErrorCode {
  VERIFICATION_POLICY_NOT_FOUND = 'VERIFICATION_POLICY_NOT_FOUND',
  VERIFICATION_POLICY_VERSION_NOT_FOUND = 'VERIFICATION_POLICY_VERSION_NOT_FOUND',
  VERIFICATION_VERDICT_NOT_FOUND = 'VERIFICATION_VERDICT_NOT_FOUND',
  VERIFICATION_SEMANTIC_CONTEXT_INCOMPLETE = 'VERIFICATION_SEMANTIC_CONTEXT_INCOMPLETE',
  VERIFICATION_SAMPLE_RATE_UNDERIVABLE = 'VERIFICATION_SAMPLE_RATE_UNDERIVABLE',
  VERIFICATION_DECISION_POLICY_INVALID = 'VERIFICATION_DECISION_POLICY_INVALID',
  VERIFICATION_POLICY_PROMOTION_REFUSED = 'VERIFICATION_POLICY_PROMOTION_REFUSED',
  VERIFICATION_POLICY_TRANSITION_LOST = 'VERIFICATION_POLICY_TRANSITION_LOST',
  VERIFICATION_POLICY_RULES_INVALID = 'VERIFICATION_POLICY_RULES_INVALID',
  VERIFICATION_RECORD_NOT_FOUND = 'VERIFICATION_RECORD_NOT_FOUND',
  VERIFICATION_LABEL_REFUSED = 'VERIFICATION_LABEL_REFUSED',
  VERIFICATION_RECEIPT_NOT_FOUND = 'VERIFICATION_RECEIPT_NOT_FOUND',
  VERIFICATION_SUMMARY_INVALID_RANGE = 'VERIFICATION_SUMMARY_INVALID_RANGE',
  VERIFICATION_SUMMARY_MULTIPLE_ASSETS = 'VERIFICATION_SUMMARY_MULTIPLE_ASSETS',
  // ── Verifier signing key ─────────────────────────────────────────────────
  VERIFICATION_SIGNER_BACKEND_UNSUPPORTED = 'VERIFICATION_SIGNER_BACKEND_UNSUPPORTED',
  VERIFICATION_SIGNING_KEY_MATERIAL_INVALID = 'VERIFICATION_SIGNING_KEY_MATERIAL_INVALID',
  VERIFICATION_SIGNING_KEY_UNKNOWN = 'VERIFICATION_SIGNING_KEY_UNKNOWN',
  VERIFICATION_SIGNING_KEY_NOT_SIGNABLE = 'VERIFICATION_SIGNING_KEY_NOT_SIGNABLE',
  VERIFICATION_SIGNING_KEY_TRANSITION_INVALID = 'VERIFICATION_SIGNING_KEY_TRANSITION_INVALID',
  VERIFICATION_SIGNING_NO_ACTIVE_KEY = 'VERIFICATION_SIGNING_NO_ACTIVE_KEY',
  VERIFICATION_SIGNING_RATE_LIMITED = 'VERIFICATION_SIGNING_RATE_LIMITED',
  // ── Evidence pack ────────────────────────────────────────────────────────
  VERIFICATION_EVIDENCE_PACK_NOT_FOUND = 'VERIFICATION_EVIDENCE_PACK_NOT_FOUND',
  VERIFICATION_EVIDENCE_PACK_TAMPERED = 'VERIFICATION_EVIDENCE_PACK_TAMPERED',
}

export type VerificationErrorCodesArePrefixed = AssertDomainErrorCodes<
  'VERIFICATION',
  `${VerificationErrorCode}`
>;

export const VerificationErrors = createDomainErrorFactory('VERIFICATION', {
  policyNotFound: {
    code: VerificationErrorCode.VERIFICATION_POLICY_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Verification policy not found${context?.toolId ? ` for tool: ${context.toolId}` : ''}`,
  },
  policyVersionNotFound: {
    code: VerificationErrorCode.VERIFICATION_POLICY_VERSION_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Policy version not found${context?.policyId ? ` for policy ${context.policyId}` : ''}` +
      `${context?.version ? ` at version ${context.version}` : ''}`,
  },
  /**
   * Covers both lookups the verdict feed does: by `verification_records
   * .id` (`GET /verdicts/:id`, `GET /verdicts/:id/evidence`) and — pre-existing
   * — by `intentId` (the crash-resume path). `context` carries whichever one
   * the caller had.
   */
  verdictNotFound: {
    code: VerificationErrorCode.VERIFICATION_VERDICT_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Verdict not found` +
      `${context?.id ? ` with id: ${context.id}` : ''}` +
      `${context?.intentId ? ` for intent: ${context.intentId}` : ''}`,
  },
  /**
   * No pack for this verdict, or one that belongs to somebody else.
   *
   * 404 for both, never 403: a status code that distinguished "does not exist"
   * from "not yours" would let an id be confirmed by anyone holding a token.
   */
  evidencePackNotFound: {
    code: VerificationErrorCode.VERIFICATION_EVIDENCE_PACK_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `No evidence pack for verdict${context?.verdictId ? ` ${context.verdictId}` : ''}`,
  },
  /**
   * The pack no longer hashes to the digest stored beside it.
   *
   * A 500 and not a 200 with a warning flag: a pack that fails its own hash is
   * not evidence, and serving it as evidence is worse than serving nothing. It
   * is also not a 4xx — nothing the caller did caused this, and the caller
   * cannot fix it.
   */
  evidencePackTampered: {
    code: VerificationErrorCode.VERIFICATION_EVIDENCE_PACK_TAMPERED,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Evidence pack${context?.packId ? ` ${context.packId}` : ''} does not match its content hash`,
  },
  /**
   * A semantic judgement arrived without the facts that make it reproducible.
   *
   * Raised at the point the judgement would be admitted into a verdict, not at
   * the point it is read back — a verdict that cannot be re-derived is not
   * evidence, and evidence is the only thing a slash may rest on.
   */
  semanticContextIncomplete: {
    code: VerificationErrorCode.VERIFICATION_SEMANTIC_CONTEXT_INCOMPLETE,
    statusCode: 422,
    message: (context?: Record<string, any>) =>
      `Semantic judgement is not reproducible and was refused` +
      `${context?.field ? `: ${context.field}` : ''}` +
      `${context?.reason ? ` (${context.reason})` : ''}`,
  },
  sampleRateUnderivable: {
    code: VerificationErrorCode.VERIFICATION_SAMPLE_RATE_UNDERIVABLE,
    statusCode: 422,
    message: (context?: Record<string, any>) =>
      `Sample rate cannot be derived${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /**
   * A decision policy that could strike somebody for the wrong reason.
   *
   * Raised at registration, never at aggregation. A malformed quorum rule
   * discovered on the settlement path has already been applied to somebody's
   * money; discovered at registration it is a form validation error in front of
   * the person who wrote it.
   */
  decisionPolicyInvalid: {
    code: VerificationErrorCode.VERIFICATION_DECISION_POLICY_INVALID,
    statusCode: 422,
    message: (context?: Record<string, any>) =>
      `Decision policy is invalid` +
      `${context?.policyId ? ` (${context.policyId}` : ''}` +
      `${context?.policyId && context?.version ? ` v${context.version}` : ''}` +
      `${context?.policyId ? ')' : ''}` +
      `${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /**
   * The promote gate said no.
   *
   * `409`, not `403`: the request was permitted and the policy is simply not in
   * a state where promotion is a legal transition yet. The failures are in the
   * context so the console can list every unmet bar at once.
   */
  policyPromotionRefused: {
    code: VerificationErrorCode.VERIFICATION_POLICY_PROMOTION_REFUSED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Policy promotion refused` +
      `${context?.policyId ? ` for ${context.policyId}` : ''}` +
      `${context?.version ? ` v${context.version}` : ''}` +
      `${context?.reasons ? `: ${context.reasons}` : ''}`,
    // Counts and bar names only: the operator console lists every unmet bar.
    publicContext: ['failures', 'falsePositiveRate'],
  },
  /**
   * A lifecycle compare-and-swap that changed no rows.
   *
   * Somebody else moved this version first. During an incident the distinction
   * between "I withdrew it" and "I believe I withdrew it" is the whole point of
   * telling the loser they lost.
   */
  policyTransitionLost: {
    code: VerificationErrorCode.VERIFICATION_POLICY_TRANSITION_LOST,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Policy lifecycle changed underneath this request` +
      `${context?.policyId ? ` (${context.policyId}` : ''}` +
      `${context?.policyId && context?.version ? ` v${context.version}` : ''}` +
      `${context?.policyId ? ')' : ''}` +
      `${context?.expected ? ` — expected ${context.expected}` : ''}`,
  },
  /** Declared verification rules that cannot be registered; every problem listed. */
  policyRulesInvalid: {
    code: VerificationErrorCode.VERIFICATION_POLICY_RULES_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Not valid verification rules` +
      `${Array.isArray(context?.problems) && context.problems.length ? `: ${context.problems.join('; ')}` : ''}`,
    publicContext: ['problems'],
  },
  /** No such verification record (operator surface: records span tenants). */
  recordNotFound: {
    code: VerificationErrorCode.VERIFICATION_RECORD_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Verification record not found${context?.recordId ? `: ${context.recordId}` : ''}`,
  },
  /**
   * A trial label that cannot be written: the record is not a trial verdict,
   * its policy version left SHADOW, the labeller wrote that policy, or another
   * operator already labelled it.
   */
  labelRefused: {
    code: VerificationErrorCode.VERIFICATION_LABEL_REFUSED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This call cannot be labelled${context?.reason ? `: ${context.reason}` : ''}`,
    publicContext: ['reason'],
  },
  /**
   * No such intent in this organization — distinct from an intent that
   * exists but has no `verification_records` row yet, which renders honestly
   * rather than 404ing. See `ReceiptService`.
   */
  receiptNotFound: {
    code: VerificationErrorCode.VERIFICATION_RECEIPT_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Receipt not found${context?.intentId ? ` for intent: ${context.intentId}` : ''}`,
  },
  /**
   * `from` must be strictly before `to` — a zero or negative window has
   * no `previous_period` of the same length either. Also raised for a
   * malformed `?asset=` filter, where `context.reason` carries the specifics.
   */
  summaryInvalidRange: {
    code: VerificationErrorCode.VERIFICATION_SUMMARY_INVALID_RANGE,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Invalid summary request` +
      `${context?.from ? `: from ${context.from}` : ''}` +
      `${context?.to ? ` to ${context.to}` : ''}` +
      `${context?.reason ? ` (${context.reason})` : ' — from must be strictly before to'}`,
  },
  /**
   * `Money` cannot be summed across assets (`MoneyUtil.sum` refuses
   * it), so a window spanning more than one asset with no `asset` filter is
   * refused rather than silently mixed into one meaningless total.
   */
  summaryMultipleAssets: {
    code: VerificationErrorCode.VERIFICATION_SUMMARY_MULTIPLE_ASSETS,
    statusCode: 422,
    message: (context?: Record<string, any>) =>
      `The requested window spans more than one asset (${context?.assets ?? '?'})` +
      ` — pass ?asset= to pick one`,
  },

  // ── Verifier signing key ───────────────────────────────────────────────────
  //
  // Every message below is written on the assumption that it will be read in a
  // log during a key-compromise investigation, and — the constraint that shapes
  // all of them — **none may ever interpolate key material.** `context` on this
  // group carries key ids, backends and counts. Never a secret, never a seed,
  // never a parsed value.

  signerBackendUnsupported: {
    code: VerificationErrorCode.VERIFICATION_SIGNER_BACKEND_UNSUPPORTED,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `No signer implementation for backend "${context?.backend ?? '?'}"` +
      `${context?.supported ? ` — supported: ${context.supported}` : ''}`,
  },
  /**
   * Raised at boot, never on the signing path. Key material that cannot be
   * loaded is a deployment that must not start: a verifier process running
   * without a key would fail every attestation later, one at a time, looking
   * like a chain problem.
   */
  signingKeyMaterialInvalid: {
    code: VerificationErrorCode.VERIFICATION_SIGNING_KEY_MATERIAL_INVALID,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Verifier signing key material is unusable${context?.reason ? `: ${context.reason}` : ''}`,
  },
  signingKeyUnknown: {
    code: VerificationErrorCode.VERIFICATION_SIGNING_KEY_UNKNOWN,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `No signing key "${context?.keyId ?? '?'}"` +
      `${context?.backend ? ` in the ${context.backend} backend` : ''}`,
  },
  /**
   * The key exists and this process could sign with it — and must not.
   *
   * `409` rather than `403`: nothing about the caller is wrong. The refusal is
   * about the key's state, and `context.reason` says which of the four it is
   * (not active locally, absent from the on-chain registry, revoked on-chain,
   * or past its registered expiry).
   */
  signingKeyNotSignable: {
    code: VerificationErrorCode.VERIFICATION_SIGNING_KEY_NOT_SIGNABLE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Signing key "${context?.keyId ?? '?'}" may not sign` +
      `${context?.reason ? `: ${context.reason}` : ''}`,
  },
  signingKeyTransitionInvalid: {
    code: VerificationErrorCode.VERIFICATION_SIGNING_KEY_TRANSITION_INVALID,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Signing key "${context?.keyId ?? '?'}" cannot go ` +
      `${context?.from ?? '?'} → ${context?.to ?? '?'}` +
      `${context?.reason ? ` (${context.reason})` : ''}`,
  },
  /**
   * `503`, deliberately. There is no key this deployment is allowed to sign
   * with right now — during a rotation gap, or after a revocation — and the
   * honest answer is "this capability is unavailable", not "your request was
   * bad". Attestation issuance stops; nothing else does. Failing closed here
   * means no penalty issues, which is the safe direction.
   */
  signingNoActiveKey: {
    code: VerificationErrorCode.VERIFICATION_SIGNING_NO_ACTIVE_KEY,
    statusCode: 503,
    message: (context?: Record<string, any>) =>
      `No verifier signing key is active` +
      `${context?.chainId ? ` for ${context.chainId}` : ''}` +
      ` — attestation issuance is halted`,
  },
  /**
   * The signing rate limit refused this request.
   *
   * A signature is a step towards taking a provider's money, so an unusual
   * *rate* of them is the earliest observable symptom of a stolen key — earlier
   * than any single signature looking wrong. The limit is what turns that
   * symptom into a bound.
   */
  signingRateLimited: {
    code: VerificationErrorCode.VERIFICATION_SIGNING_RATE_LIMITED,
    statusCode: 429,
    message: (context?: Record<string, any>) =>
      `Verifier signing rate limit exceeded` +
      `${context?.scope ? ` for ${context.scope}` : ''}` +
      `${context?.observed && context?.limit ? ` — ${context.observed}/${context.limit}` : ''}` +
      `${context?.windowSeconds ? ` in ${context.windowSeconds}s` : ''}`,
  },
});
