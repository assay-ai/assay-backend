import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `MCP_*` — the MCP server surface: `tools/list` with prices and `tools/call`.
 * This is the interface agents actually reach the platform through, so its
 * errors are the ones an agent sees most often.
 */
export enum McpErrorCode {
  MCP_REQUEST_MALFORMED = 'MCP_REQUEST_MALFORMED',
  MCP_METHOD_NOT_SUPPORTED = 'MCP_METHOD_NOT_SUPPORTED',
  MCP_TOOL_NOT_FOUND = 'MCP_TOOL_NOT_FOUND',
  MCP_CREDENTIAL_INVALID = 'MCP_CREDENTIAL_INVALID',
  MCP_CREDENTIAL_REVOKED = 'MCP_CREDENTIAL_REVOKED',
  MCP_SESSION_NOT_FOUND = 'MCP_SESSION_NOT_FOUND',
  MCP_QUOTA_EXCEEDED = 'MCP_QUOTA_EXCEEDED',

  // ── the public live demo ─────────────────────────────────────────────────
  MCP_DEMO_QUERY_INVALID = 'MCP_DEMO_QUERY_INVALID',
  MCP_DEMO_RATE_LIMITED = 'MCP_DEMO_RATE_LIMITED',
  MCP_DEMO_CALL_NOT_FOUND = 'MCP_DEMO_CALL_NOT_FOUND',
  MCP_SPEND_LIMIT_EXCEEDED = 'MCP_SPEND_LIMIT_EXCEEDED',
  /**
   * A human paused this agent's paid calls. Distinct from
   * `MCP_SPEND_LIMIT_EXCEEDED` on purpose: so the agent's logs say "a human
   * stopped this", not "out of money" — collapsing the two into one code is
   * a support cost that lasts for years.
   */
  MCP_POLICY_AGENT_PAUSED = 'MCP_POLICY_AGENT_PAUSED',
  /**
   * The price is above the policy's `requireApprovalAbove`. There is no
   * approval flow yet, so such a call is refused rather than let through: an
   * approval that cannot be asked for must resolve to DENY, never ALLOW.
   */
  MCP_APPROVAL_REQUIRED = 'MCP_APPROVAL_REQUIRED',
  /**
   * Calls/minute, calls/hour, spend/hour or a duplicate
   * request hash. The UI calls this `VELOCITY_LIMIT_EXCEEDED`; the `MCP_`
   * prefix is this catalogue's own convention, not a different situation.
   * Unlike a cap or a pause, this one is `retryable` — the window it was
   * measured in rolls over on its own.
   */
  MCP_VELOCITY_LIMIT_EXCEEDED = 'MCP_VELOCITY_LIMIT_EXCEEDED',
  /**
   * `spend_policies.allowed_tools` does not include this tool. Not one of the
   * UI's four limit codes (those are about caps, velocity, funds and pause);
   * added here because the allowlist is a fifth, distinct refusal reason that
   * none of those four codes can honestly carry.
   */
  MCP_TOOL_NOT_ALLOWED = 'MCP_TOOL_NOT_ALLOWED',
}

export type McpErrorCodesArePrefixed = AssertDomainErrorCodes<'MCP', `${McpErrorCode}`>;

/**
 * One code carries four different refusals; the sentence says which one, so an
 * owner is not sent to raise a spend limit when the call was a duplicate. Keys
 * are `VelocityViolationKind` values, kept as strings because the spend-policy
 * module imports this file, not the other way round.
 */
const VELOCITY_REASON_TEXT: Record<string, string> = {
  CALLS_PER_MINUTE: `The agent's calls-per-minute limit is used up`,
  CALLS_PER_HOUR: `The agent's calls-per-hour limit is used up`,
  SPEND_PER_HOUR: `The agent's spend-per-hour limit is used up`,
  DUPLICATE_REQUEST:
    `The same call (same tool, same arguments) was repeated too many times within one minute ` +
    `and was refused as a duplicate`,
};

export const McpErrors = createDomainErrorFactory('MCP', {
  requestMalformed: {
    code: McpErrorCode.MCP_REQUEST_MALFORMED,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Malformed MCP request${context?.detail ? `: ${context.detail}` : ''}`,
  },
  methodNotSupported: {
    code: McpErrorCode.MCP_METHOD_NOT_SUPPORTED,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `MCP method not supported${context?.method ? `: ${context.method}` : ''}`,
  },
  toolNotFound: {
    code: McpErrorCode.MCP_TOOL_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Tool is not in this credential's catalogue${context?.name ? `: ${context.name}` : ''}`,
  },
  credentialInvalid: {
    code: McpErrorCode.MCP_CREDENTIAL_INVALID,
    statusCode: 401,
    message: () => `MCP credential is missing or invalid`,
  },
  credentialRevoked: {
    code: McpErrorCode.MCP_CREDENTIAL_REVOKED,
    statusCode: 401,
    message: (context?: Record<string, any>) =>
      `MCP credential has been revoked` + `${context?.revokedAt ? ` at ${context.revokedAt}` : ''}`,
  },
  sessionNotFound: {
    code: McpErrorCode.MCP_SESSION_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `MCP session not found${context?.sessionId ? `: ${context.sessionId}` : ''}`,
  },
  quotaExceeded: {
    code: McpErrorCode.MCP_QUOTA_EXCEEDED,
    statusCode: 429,
    message: (context?: Record<string, any>) =>
      `Free-tier quota exceeded` +
      `${context?.limit ? `: ${context.limit}` : ''}` +
      `${context?.paidAlternative ? ` — paid alternative: ${context.paidAlternative}` : ''}`,
  },
  spendLimitExceeded: {
    code: McpErrorCode.MCP_SPEND_LIMIT_EXCEEDED,
    statusCode: 429,
    message: (context?: Record<string, any>) =>
      `Call would exceed the agent's spend policy` +
      `${context?.limitType ? ` (${context.limitType})` : ''}` +
      `${context?.limit ? ` (limit: ${context.limit})` : ''}` +
      `${context?.resetsAt ? `, resets at ${context.resetsAt}` : ''}`,
  },
  /** The circuit breaker. See `McpErrorCode.MCP_POLICY_AGENT_PAUSED`. */
  policyAgentPaused: {
    code: McpErrorCode.MCP_POLICY_AGENT_PAUSED,
    statusCode: 403,
    message: (_context?: Record<string, any>) => `A human has paused this agent's paid calls`,
  },
  /** See `McpErrorCode.MCP_APPROVAL_REQUIRED`. */
  approvalRequired: {
    code: McpErrorCode.MCP_APPROVAL_REQUIRED,
    statusCode: 403,
    message: (context?: Record<string, any>) =>
      `This call costs more than the agent's approval threshold` +
      `${context?.threshold ? ` (${context.threshold})` : ''}. Approvals are not available yet, ` +
      `so it was refused; raise or clear requireApprovalAbove to allow it.`,
  },
  /** Velocity. See `McpErrorCode.MCP_VELOCITY_LIMIT_EXCEEDED`. */
  velocityLimitExceeded: {
    code: McpErrorCode.MCP_VELOCITY_LIMIT_EXCEEDED,
    statusCode: 429,
    message: (context?: Record<string, any>) =>
      `${VELOCITY_REASON_TEXT[context?.reason] ?? `Call rate exceeded the agent's velocity limit`}` +
      `${context?.reason ? ` (${context.reason})` : ''}` +
      `; ${context?.reason === 'DUPLICATE_REQUEST' ? 'no spend limit is used up and ' : ''}` +
      `nothing was charged` +
      `${context?.retryAfter ? `, retry after ${context.retryAfter}s` : ''}`,
  },
  /** The tool allowlist. See `McpErrorCode.MCP_TOOL_NOT_ALLOWED`. */
  toolNotAllowed: {
    code: McpErrorCode.MCP_TOOL_NOT_ALLOWED,
    statusCode: 403,
    message: (context?: Record<string, any>) =>
      `Tool is not on this agent's spend-policy allowlist${context?.toolId ? `: ${context.toolId}` : ''}`,
  },

  // ── the public live demo ─────────────────────────────────────────────────

  /** Free text needs a bound; there is one here and a rate limit behind it. */
  demoQueryInvalid: {
    code: McpErrorCode.MCP_DEMO_QUERY_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Demo query is not usable${context?.detail ? `: ${context.detail}` : ''}`,
  },

  /**
   * The per-IP window, which protects the **provider's upstream**. Distinct
   * from `spendLimitExceeded`, which is the demo agent's own budget and
   * protects the platform's wallet — two limits, two messages, because an
   * operator reading a log needs to know which one bit.
   */
  demoRateLimited: {
    code: McpErrorCode.MCP_DEMO_RATE_LIMITED,
    statusCode: 429,
    message: (context?: Record<string, any>) =>
      `Too many demo calls from this address` +
      `${context?.reason ? ` (${context.reason})` : ''}. Try again shortly.`,
  },

  /**
   * **404 on purpose, never 403.** The verdict route takes an id with no
   * session behind it, so an intent outside the demo organization must be
   * indistinguishable from one that never existed — a 403 would confirm the id
   * is real and turn the route into an oracle for which calls exist.
   */
  demoCallNotFound: {
    code: McpErrorCode.MCP_DEMO_CALL_NOT_FOUND,
    statusCode: 404,
    message: () => 'No such demo call',
  },
});
