import { AppError } from '@shared/errors/app-errors';

/**
 * Why the MCP catch-all answered 401 (the `mcp_unauthorized{reason}` counter,
 * spec §6.7).
 *
 * ```text
 * missing   no bearer token
 * unknown   a token no source recognised
 * expired   an OAuth access token (or its grant) past its expiry
 * revoked   an OAuth access token (or its grant) revoked
 * audience  an OAuth access token for another resource
 * ```
 *
 * Only the OAuth session source can tell the last three apart. It attaches
 * the reason to the `MCP_CREDENTIAL_INVALID` error's **private** context
 * (`AppError.context`, under {@link UNAUTHORIZED_REASON_KEY}); the error's
 * definition declares no `publicContext`, so `AllExceptionsFilter` never puts
 * it on the wire, and the 401 body stays identical whatever the reason. The
 * value is a closed label, never the token or anything derived from it.
 */
export type McpUnauthorizedReason = 'missing' | 'unknown' | 'expired' | 'revoked' | 'audience';

export const UNAUTHORIZED_REASON_KEY = 'unauthorizedReason';

const REASONS: ReadonlySet<string> = new Set([
  'missing',
  'unknown',
  'expired',
  'revoked',
  'audience',
]);

/** The reason a source attached to an `MCP_CREDENTIAL_INVALID` error, or `null`. */
export function unauthorizedReasonOf(error: unknown): McpUnauthorizedReason | null {
  if (!(error instanceof AppError)) return null;
  const reason = error.context?.[UNAUTHORIZED_REASON_KEY];
  return typeof reason === 'string' && REASONS.has(reason)
    ? (reason as McpUnauthorizedReason)
    : null;
}

/** Counts the catch-all's 401s. Provided only on the MCP app (by `OAuthMcpModule`). */
export interface McpUnauthorizedRecorder {
  record(reason: McpUnauthorizedReason): void;
}

export const MCP_UNAUTHORIZED_RECORDER = Symbol('MCP_UNAUTHORIZED_RECORDER');
