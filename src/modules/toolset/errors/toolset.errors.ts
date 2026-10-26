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
  TOOLSET_HANDLE_INVALID = 'TOOLSET_HANDLE_INVALID',
  TOOLSET_HANDLE_TAKEN = 'TOOLSET_HANDLE_TAKEN',
  TOOLSET_HANDLE_LOCKED = 'TOOLSET_HANDLE_LOCKED',
  TOOLSET_HANDLE_REQUIRED = 'TOOLSET_HANDLE_REQUIRED',
  TOOLSET_HANDLE_CLAIM_REFUSED = 'TOOLSET_HANDLE_CLAIM_REFUSED',
  TOOLSET_SHARING_REFUSED = 'TOOLSET_SHARING_REFUSED',
  TOOLSET_NOT_PUBLISHABLE = 'TOOLSET_NOT_PUBLISHABLE',
  TOOLSET_VERSION_NOT_FOUND = 'TOOLSET_VERSION_NOT_FOUND',
  TOOLSET_SLUG_LOCKED = 'TOOLSET_SLUG_LOCKED',
  TOOLSET_REPORT_DUPLICATE = 'TOOLSET_REPORT_DUPLICATE',
  TOOLSET_REPORT_TARGET_NOT_FOUND = 'TOOLSET_REPORT_TARGET_NOT_FOUND',
  TOOLSET_REPORT_NOT_FOUND = 'TOOLSET_REPORT_NOT_FOUND',
  TOOLSET_CUTOFF_NOT_FOUND = 'TOOLSET_CUTOFF_NOT_FOUND',
  TOOLSET_CUTOFF_NOT_PENDING = 'TOOLSET_CUTOFF_NOT_PENDING',
  TOOLSET_CUTOFF_SELF_CONFIRM = 'TOOLSET_CUTOFF_SELF_CONFIRM',
  TOOLSET_HANDLE_NOT_FOUND = 'TOOLSET_HANDLE_NOT_FOUND',
  TOOLSET_HANDLE_REASSIGN_REFUSED = 'TOOLSET_HANDLE_REASSIGN_REFUSED',
  TOOLSET_ORGANIZATION_NOT_FOUND = 'TOOLSET_ORGANIZATION_NOT_FOUND',
  TOOLSET_STATE = 'TOOLSET_STATE',
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
  handleInvalid: {
    code: ToolsetErrorCode.TOOLSET_HANDLE_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      context?.reason === 'RESERVED'
        ? 'This public name is reserved'
        : context?.reason === 'TOOL_NAME_TOO_LONG'
          ? 'A provider tool name would pass 48 characters under this public name'
          : 'A public name is 3–24 characters: lowercase letters, digits and "-", starting with a letter',
    publicContext: ['reason'],
  },
  /** Taken by another organization, or held after a rename or a takedown. */
  handleTaken: {
    code: ToolsetErrorCode.TOOLSET_HANDLE_TAKEN,
    statusCode: 409,
    message: (_context?: Record<string, any>) => 'This public name is taken',
    publicContext: ['suggestions'],
  },
  handleLocked: {
    code: ToolsetErrorCode.TOOLSET_HANDLE_LOCKED,
    statusCode: 409,
    message: () => 'Your public name is in use by a shared tool set; ask support to rename it',
  },
  handleRequired: {
    code: ToolsetErrorCode.TOOLSET_HANDLE_REQUIRED,
    statusCode: 409,
    message: () => 'Choose a public name before sharing',
  },
  /** `NOT_VERIFIED` (fund once first) | `CLAIM_LIMIT` (3 organizations per person per 30 days). */
  handleClaimRefused: {
    code: ToolsetErrorCode.TOOLSET_HANDLE_CLAIM_REFUSED,
    statusCode: 403,
    message: (context?: Record<string, any>) =>
      context?.reason === 'CLAIM_LIMIT'
        ? 'You have claimed public names for 3 organizations in the last 30 days'
        : 'Add funds once before choosing a public name',
    publicContext: ['reason'],
  },
  /** A share-state change the state machine refuses (`refusal`). */
  sharingRefused: {
    code: ToolsetErrorCode.TOOLSET_SHARING_REFUSED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This tool set cannot be changed that way${context?.refusal ? ` (${context.refusal})` : ''}`,
    publicContext: ['refusal'],
  },
  notPublishable: {
    code: ToolsetErrorCode.TOOLSET_NOT_PUBLISHABLE,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `This tool set cannot be published${context?.reason ? `: ${context.reason}` : ''}`,
    publicContext: ['reason', 'toolIds'],
  },
  versionNotFound: {
    code: ToolsetErrorCode.TOOLSET_VERSION_NOT_FOUND,
    statusCode: 404,
    message: () => 'Tool set version not found',
  },
  slugLocked: {
    code: ToolsetErrorCode.TOOLSET_SLUG_LOCKED,
    statusCode: 409,
    message: () => 'The slug of a tool set that has been shared cannot change',
  },
  reportDuplicate: {
    code: ToolsetErrorCode.TOOLSET_REPORT_DUPLICATE,
    statusCode: 409,
    message: () => 'Your organization already has an open report about this',
  },
  /** The same 404 for a missing target and one the reporter cannot see. */
  reportTargetNotFound: {
    code: ToolsetErrorCode.TOOLSET_REPORT_TARGET_NOT_FOUND,
    statusCode: 404,
    message: () => 'Nothing to report was found',
  },
  reportNotFound: {
    code: ToolsetErrorCode.TOOLSET_REPORT_NOT_FOUND,
    statusCode: 404,
    message: () => 'Report not found',
  },
  cutoffNotFound: {
    code: ToolsetErrorCode.TOOLSET_CUTOFF_NOT_FOUND,
    statusCode: 404,
    message: () => 'Cutoff not found',
  },
  /** Already confirmed or reverted. */
  cutoffNotPending: {
    code: ToolsetErrorCode.TOOLSET_CUTOFF_NOT_PENDING,
    statusCode: 409,
    message: (_context?: Record<string, any>) =>
      'This cutoff is no longer waiting for confirmation',
    publicContext: ['status'],
  },
  /** FR-18: the second operator must be somebody else. */
  cutoffSelfConfirm: {
    code: ToolsetErrorCode.TOOLSET_CUTOFF_SELF_CONFIRM,
    statusCode: 409,
    message: () => 'A cutoff is confirmed by a second operator, not the one who made it',
  },
  handleNotFound: {
    code: ToolsetErrorCode.TOOLSET_HANDLE_NOT_FOUND,
    statusCode: 404,
    message: () => 'Handle not found',
  },
  handleReassignRefused: {
    code: ToolsetErrorCode.TOOLSET_HANDLE_REASSIGN_REFUSED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `The handle cannot be reassigned${context?.reason ? `: ${context.reason}` : ''}`,
    publicContext: ['reason'],
  },
  /** A reassign names an organization that does not exist; nothing is queued. */
  organizationNotFound: {
    code: ToolsetErrorCode.TOOLSET_ORGANIZATION_NOT_FOUND,
    statusCode: 404,
    message: () => 'Organization not found',
  },
  refusedCallNotFound: {
    code: ToolsetErrorCode.TOOLSET_REFUSED_CALL_NOT_FOUND,
    statusCode: 404,
    message: () => 'Refused call not found',
  },
  /** The tool set is not in the state the action needs (`reason` says which). */
  state: {
    code: ToolsetErrorCode.TOOLSET_STATE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This tool set cannot be changed now${context?.reason ? `: ${context.reason}` : ''}`,
    publicContext: ['reason'],
  },
});
