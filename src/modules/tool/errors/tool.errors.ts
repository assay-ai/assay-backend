import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `TOOL_*` — tools, bindings, the router and the response classifier.
 */
export enum ToolErrorCode {
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  TOOL_ARGUMENTS_INVALID = 'TOOL_ARGUMENTS_INVALID',
  TOOL_MAPPING_INVALID = 'TOOL_MAPPING_INVALID',
  TOOL_MAPPING_PATH_NOT_FOUND = 'TOOL_MAPPING_PATH_NOT_FOUND',
  TOOL_MAPPING_REQUIRED_FIELD_MISSING = 'TOOL_MAPPING_REQUIRED_FIELD_MISSING',
  TOOL_MAPPING_TYPE_MISMATCH = 'TOOL_MAPPING_TYPE_MISMATCH',
  TOOL_MAPPING_NULL_VALUE = 'TOOL_MAPPING_NULL_VALUE',
  TOOL_MAPPING_EMPTY_COLLECTION = 'TOOL_MAPPING_EMPTY_COLLECTION',
  TOOL_MAPPING_TRANSFORM_FAILED = 'TOOL_MAPPING_TRANSFORM_FAILED',
  TOOL_NO_ELIGIBLE_BINDING = 'TOOL_NO_ELIGIBLE_BINDING',
  TOOL_PROVIDER_SLASH_HOLD = 'TOOL_PROVIDER_SLASH_HOLD',
  TOOL_ALL_BINDINGS_FAILED = 'TOOL_ALL_BINDINGS_FAILED',
  /** T3, the contract editor: a version that cannot be a contract (`details.problems`). */
  TOOL_CONTRACT_INVALID = 'TOOL_CONTRACT_INVALID',
  /** T3: the action does not fit the tool's or the version's state (`details.reason`). */
  TOOL_CONTRACT_STATE = 'TOOL_CONTRACT_STATE',
  /** T3: another tool holds the name. */
  TOOL_CONTRACT_NAME_TAKEN = 'TOOL_CONTRACT_NAME_TAKEN',
  /** T3: the draft is identical to the version it is based on. */
  TOOL_CONTRACT_NO_CHANGES = 'TOOL_CONTRACT_NO_CHANGES',
  /** T3: no such version of this tool. */
  TOOL_VERSION_NOT_FOUND = 'TOOL_VERSION_NOT_FOUND',
}

export type ToolErrorCodesArePrefixed = AssertDomainErrorCodes<'TOOL', `${ToolErrorCode}`>;

export const ToolErrors = createDomainErrorFactory('TOOL', {
  contractInvalid: {
    code: ToolErrorCode.TOOL_CONTRACT_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Not a valid contract` +
      `${Array.isArray(context?.problems) && context.problems.length ? `: ${context.problems.join('; ')}` : ''}`,
    publicContext: ['problems'],
  },
  contractState: {
    code: ToolErrorCode.TOOL_CONTRACT_STATE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Not possible in this state${context?.reason ? `: ${context.reason}` : ''}`,
    publicContext: ['reason'],
  },
  contractNameTaken: {
    code: ToolErrorCode.TOOL_CONTRACT_NAME_TAKEN,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `A tool is already named ${context?.name ?? 'that'}` +
      `${context?.suggestion ? `; ${context.suggestion} is free` : ''}`,
    publicContext: ['name', 'suggestion'],
  },
  contractNoChanges: {
    code: ToolErrorCode.TOOL_CONTRACT_NO_CHANGES,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `The draft is identical to v${context?.base ?? '?'}; there is nothing to publish`,
    publicContext: ['base'],
  },
  versionNotFound: {
    code: ToolErrorCode.TOOL_VERSION_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `No such version${context?.version ? `: ${context.version}` : ''}`,
  },
  toolNotFound: {
    code: ToolErrorCode.TOOL_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Tool not found${context?.toolId ? `: ${context.toolId}` : ''}`,
  },
  argumentsInvalid: {
    code: ToolErrorCode.TOOL_ARGUMENTS_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Tool arguments failed schema validation` + `${context?.detail ? `: ${context.detail}` : ''}`,
  },
  mappingInvalid: {
    code: ToolErrorCode.TOOL_MAPPING_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Binding mapping is invalid${context?.detail ? `: ${context.detail}` : ''}`,
  },
  /**
   * A selector resolved to nothing at all — the field is not in the document
   * at any depth. Distinct from `nullValue` on purpose: absent is evidence
   * about *our mapping*, `null` is evidence about *the provider's data*, and a
   * single code for both would erase the only signal that tells the two apart.
   */
  mappingPathNotFound: {
    code: ToolErrorCode.TOOL_MAPPING_PATH_NOT_FOUND,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Mapping selector resolved to nothing` +
      `${context?.path ? `: ${context.path}` : ''}` +
      `${context?.pointer ? ` (at ${context.pointer})` : ''}` +
      `${context?.bindingId ? ` for binding: ${context.bindingId}` : ''}`,
  },
  /** A field the schema marks `required` is absent from the mapped document. */
  mappingRequiredFieldMissing: {
    code: ToolErrorCode.TOOL_MAPPING_REQUIRED_FIELD_MISSING,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Required field is missing` +
      `${context?.pointer ? `: ${context.pointer}` : ''}` +
      `${context?.field ? ` (${context.field})` : ''}`,
  },
  /** The value is present and of the wrong JSON type for the schema. */
  mappingTypeMismatch: {
    code: ToolErrorCode.TOOL_MAPPING_TYPE_MISMATCH,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Type mismatch` +
      `${context?.pointer ? ` at ${context.pointer}` : ''}` +
      `${context?.expected ? `: expected ${context.expected}` : ''}` +
      `${context?.actual ? `, got ${context.actual}` : ''}`,
  },
  /** An explicit `null` where the contract requires a value. */
  mappingNullValue: {
    code: ToolErrorCode.TOOL_MAPPING_NULL_VALUE,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Value is null where the contract requires a value` +
      `${context?.pointer ? `: ${context.pointer}` : ''}` +
      `${context?.path ? ` (from ${context.path})` : ''}`,
  },
  /**
   * A collection resolved to zero elements at a site that declares results are
   * mandatory. Not raised by default — an honest empty answer is `EMPTY_CONFIRMED`
   * in the verdict vocabulary, not a failure.
   */
  mappingEmptyCollection: {
    code: ToolErrorCode.TOOL_MAPPING_EMPTY_COLLECTION,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Collection is empty where the contract requires results` +
      `${context?.pointer ? `: ${context.pointer}` : ''}` +
      `${context?.path ? ` (from ${context.path})` : ''}`,
  },
  /** A named transform rejected its input. Never silent — the value is not passed through. */
  mappingTransformFailed: {
    code: ToolErrorCode.TOOL_MAPPING_TRANSFORM_FAILED,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Transform "${context?.transform ?? '?'}" failed` +
      `${context?.pointer ? ` at ${context.pointer}` : ''}` +
      `${context?.detail ? `: ${context.detail}` : ''}`,
  },
  /**
   * Every provider of this tool the buyer could pay is on a slash hold: its
   * penalties cannot be collected promptly, so it takes no paid calls until
   * the chain says otherwise. Transient; retry later.
   */
  providerSlashHold: {
    code: ToolErrorCode.TOOL_PROVIDER_SLASH_HOLD,
    statusCode: 503,
    message: (context?: Record<string, any>) =>
      `The provider${context?.toolId ? ` of tool ${context.toolId}` : ''} is paused while its ` +
      'outstanding penalties cannot be collected (slash hold), and no other provider can serve ' +
      'this call; retry later',
  },
  noEligibleBinding: {
    code: ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING,
    statusCode: 503,
    message: (context?: Record<string, any>) =>
      `No binding is eligible to serve this call` +
      `${context?.toolId ? ` for tool: ${context.toolId}` : ''}` +
      `${context?.reason ? ` (${context.reason})` : ''}`,
  },
  /**
   * Failover ran out of providers.
   *
   * Distinct from `noEligibleBinding`, and the distinction is the whole point:
   * that one means nobody was routable *before* we tried, this one means
   * everybody who was routable returned `SYSTEM_ERROR`. The first is a supply
   * or stake problem, the second is an outage — and a single code for both
   * would put a catalogue gap and a multi-provider incident on the same alert.
   *
   * `502`, because the failure is upstream of us and every attempt is recorded:
   * no charge settles, no strike lands, and no provider's stake is reachable
   * through this path.
   */
  allBindingsFailed: {
    code: ToolErrorCode.TOOL_ALL_BINDINGS_FAILED,
    statusCode: 502,
    message: (context?: Record<string, any>) =>
      `All ${context?.attempts ?? 0} provider attempts failed` +
      `${context?.toolId ? ` for tool: ${context.toolId}` : ''}` +
      `${context?.detail ? ` (${context.detail})` : ''}`,
  },
});
