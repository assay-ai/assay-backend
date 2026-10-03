import { Request } from 'express';

/**
 * The `Authorization: Bearer …` token, or `null` for anything else.
 *
 * Extracted from `SessionAuthGuard`, which was its only reader until
 * `POST /auth/wallet/link` — a route that must verify a Privy token *without*
 * building a session, because the session is exactly what it cannot build yet
 * (see `AuthErrors.walletNotLinked`). Two copies of this would be two answers
 * to "what counts as a bearer token", and the wrong one to get wrong.
 *
 * Returns `null` rather than throwing: what a missing credential *means* is
 * the caller's decision, and every current caller turns it into the same
 * `MCP_CREDENTIAL_INVALID` a bad one raises.
 */
export function extractBearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}
