import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `TOOLSET_*` — toolsets, access policies and the MCP URLs that serve them,
 * on the REST surface.
 */
export enum ToolsetErrorCode {
  TOOLSET_NOT_FOUND = 'TOOLSET_NOT_FOUND',
  TOOLSET_SLUG_TAKEN = 'TOOLSET_SLUG_TAKEN',
  TOOLSET_INVALID = 'TOOLSET_INVALID',
  TOOLSET_LIMIT_EXCEEDED = 'TOOLSET_LIMIT_EXCEEDED',
  TOOLSET_ACCESS_INVALID = 'TOOLSET_ACCESS_INVALID',
  TOOLSET_REFUSED_CALL_NOT_FOUND = 'TOOLSET_REFUSED_CALL_NOT_FOUND',
}

export type ToolsetErrorCodesArePrefixed = AssertDomainErrorCodes<'TOOLSET', `${ToolsetErrorCode}`>;

export const ToolsetErrors = createDomainErrorFactory('TOOLSET', {
  /** 404 for a toolset of another organization too: existence must not leak. */
  notFound: {
    code: ToolsetErrorCode.TOOLSET_NOT_FOUND,
    statusCode: 404,
    message: () => 'Tool set not found',
  },
  slugTaken: {
    code: ToolsetErrorCode.TOOLSET_SLUG_TAKEN,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `The slug${context?.slug ? ` "${context.slug}"` : ''} is already used by another of your tool sets`,
    publicContext: ['slug', 'suggestion'],
  },
  invalid: {
    code: ToolsetErrorCode.TOOLSET_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Invalid tool set${context?.reason ? `: ${context.reason}` : ''}`,
    publicContext: ['reason', 'toolIds'],
  },
  /** Beyond a limit of §7.13 the REST API answers 429. */
  limitExceeded: {
    code: ToolsetErrorCode.TOOLSET_LIMIT_EXCEEDED,
    statusCode: 429,
    message: (context?: Record<string, any>) =>
      `Limit reached${context?.limit ? `: ${context.limit}` : ''}`,
    publicContext: ['limit', 'max'],
  },
  accessInvalid: {
    code: ToolsetErrorCode.TOOLSET_ACCESS_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Invalid access policy${context?.reason ? `: ${context.reason}` : ''}`,
    publicContext: ['reason', 'toolIds', 'toolsetIds', 'tools'],
  },
  refusedCallNotFound: {
    code: ToolsetErrorCode.TOOLSET_REFUSED_CALL_NOT_FOUND,
    statusCode: 404,
    message: () => 'Refused call not found',
  },
});
