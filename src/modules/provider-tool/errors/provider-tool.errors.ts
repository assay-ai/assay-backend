import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `TOOL_*` codes of provider tools (design spec §7.6, phase T4): a provider's
 * own contract under its handle, its publish gate, its review and its
 * promotion to a standard contract.
 */
export enum ProviderToolErrorCode {
  /** Also for another organization's tool: existence must not leak. */
  TOOL_PROVIDER_TOOL_NOT_FOUND = 'TOOL_PROVIDER_TOOL_NOT_FOUND',
  /** The name, the contract or the declared rules cannot be saved (`details.problems`). */
  TOOL_PROVIDER_TOOL_INVALID = 'TOOL_PROVIDER_TOOL_INVALID',
  /** The action does not fit the tool's state (`details.reason`). */
  TOOL_PROVIDER_TOOL_STATE = 'TOOL_PROVIDER_TOOL_STATE',
  /** A review is pending: the content it is for is frozen until it is decided or withdrawn. */
  TOOL_PROVIDER_TOOL_IN_REVIEW = 'TOOL_PROVIDER_TOOL_IN_REVIEW',
  /** The publish gate refused (`details.failed`); `GET …/publish-check` has the checklist. */
  TOOL_PROVIDER_TOOL_GATE_FAILED = 'TOOL_PROVIDER_TOOL_GATE_FAILED',
  /** Another tool holds the name. */
  TOOL_PROVIDER_TOOL_NAME_TAKEN = 'TOOL_PROVIDER_TOOL_NAME_TAKEN',
  /** The organization is not a registered provider, or has no active public name. */
  TOOL_PROVIDER_TOOL_NOT_ALLOWED = 'TOOL_PROVIDER_TOOL_NOT_ALLOWED',
  /** Operator review: nothing is pending for this tool. */
  TOOL_REVIEW_NOT_PENDING = 'TOOL_REVIEW_NOT_PENDING',
  /** Operator review: the content changed since the operator read it. */
  TOOL_REVIEW_STALE = 'TOOL_REVIEW_STALE',
  /** Promotion: the source or the invited tools do not qualify (`details.reason`). */
  TOOL_PROMOTION_INVALID = 'TOOL_PROMOTION_INVALID',
}

export type ProviderToolErrorCodesArePrefixed = AssertDomainErrorCodes<
  'TOOL',
  `${ProviderToolErrorCode}`
>;

export const ProviderToolErrors = createDomainErrorFactory('TOOL', {
  notFound: {
    code: ProviderToolErrorCode.TOOL_PROVIDER_TOOL_NOT_FOUND,
    statusCode: 404,
    message: (_context?: Record<string, any>) => 'Provider tool not found',
  },
  invalid: {
    code: ProviderToolErrorCode.TOOL_PROVIDER_TOOL_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Not a valid provider tool` +
      `${Array.isArray(context?.problems) && context.problems.length ? `: ${context.problems.join('; ')}` : ''}`,
    publicContext: ['problems', 'findings'],
  },
  state: {
    code: ProviderToolErrorCode.TOOL_PROVIDER_TOOL_STATE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Not possible in this state${context?.reason ? `: ${context.reason}` : ''}`,
    publicContext: ['reason'],
  },
  inReview: {
    code: ProviderToolErrorCode.TOOL_PROVIDER_TOOL_IN_REVIEW,
    statusCode: 409,
    message: (_context?: Record<string, any>) =>
      'A review is pending: what it is for cannot change until it is decided. Withdraw it to edit.',
    publicContext: ['reviewVersion'],
  },
  gateFailed: {
    code: ProviderToolErrorCode.TOOL_PROVIDER_TOOL_GATE_FAILED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `The publish checks are not met${context?.failed ? `: ${context.failed}` : ''}`,
    publicContext: ['failed', 'findings'],
  },
  nameTaken: {
    code: ProviderToolErrorCode.TOOL_PROVIDER_TOOL_NAME_TAKEN,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `The name${context?.name ? ` "${context.name}"` : ''} is taken`,
    publicContext: ['name', 'suggestion'],
  },
  notAllowed: {
    code: ProviderToolErrorCode.TOOL_PROVIDER_TOOL_NOT_ALLOWED,
    statusCode: 403,
    message: (context?: Record<string, any>) =>
      context?.reason === 'NO_HANDLE'
        ? 'Claim a public name (PUT /org/handle) before publishing your own API'
        : 'Register as a provider before publishing your own API',
    publicContext: ['reason'],
  },
  reviewNotPending: {
    code: ProviderToolErrorCode.TOOL_REVIEW_NOT_PENDING,
    statusCode: 409,
    message: (_context?: Record<string, any>) => 'Nothing is waiting for review on this tool',
  },
  reviewStale: {
    code: ProviderToolErrorCode.TOOL_REVIEW_STALE,
    statusCode: 409,
    message: (_context?: Record<string, any>) =>
      'The content under review changed since you read it; reload the review',
    publicContext: ['contentHash'],
  },
  promotionInvalid: {
    code: ProviderToolErrorCode.TOOL_PROMOTION_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Cannot promote${context?.reason ? `: ${context.reason}` : ''}`,
    publicContext: ['reason', 'toolIds'],
  },
});
