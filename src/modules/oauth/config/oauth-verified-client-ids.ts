import { OAUTH_VERIFIED_CLIENTS_ENV } from './oauth.config';

/**
 * The client ids listed in `OAUTH_VERIFIED_CLIENTS`, for the scheduler's
 * cleanup job, which must never delete them (spec §6.2).
 *
 * The scheduler does not load `OAUTH_CONFIG` (it would demand the request
 * cookie secret and `AUTH_SESSION_SOURCE=both`), so this reads only the ids.
 * The full validation is `loadOAuthConfig`'s, at the boot of the processes
 * that serve OAuth. Here a value that cannot be read returns `null`, and the
 * caller deletes no client at all rather than guess which ones are protected.
 */
export function readVerifiedClientIds(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env[OAUTH_VERIFIED_CLIENTS_ENV];
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const ids: string[] = [];
  for (const entry of parsed) {
    const clientId = (entry as { clientId?: unknown } | null)?.clientId;
    if (typeof clientId !== 'string' || clientId.trim() === '') return null;
    ids.push(clientId);
  }
  return ids;
}
