import { CredentialVerifiedClient } from '../domain/credential-client-view';
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

/**
 * The entries of `OAUTH_VERIFIED_CLIENTS` with their display names and vendor
 * redirects, for the credentials list's "Verified" mark (spec §7.10 item 4),
 * read without loading `OAUTH_CONFIG` for the same reason as above.
 *
 * Fails closed: a value that cannot be read, or any malformed entry, returns
 * `null`, and the caller shows no client as verified. Where the OAuth routes
 * run, `loadOAuthConfig` validates the same variable fully at boot.
 */
export function readVerifiedClients(
  env: NodeJS.ProcessEnv = process.env,
): CredentialVerifiedClient[] | null {
  const raw = env[OAUTH_VERIFIED_CLIENTS_ENV];
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const clients: CredentialVerifiedClient[] = [];
  for (const entry of parsed) {
    const { clientId, displayName, vendorRedirects } = (entry ?? {}) as Record<string, unknown>;
    if (
      !isHttpsUrl(clientId) ||
      typeof displayName !== 'string' ||
      displayName.trim() === '' ||
      !Array.isArray(vendorRedirects) ||
      vendorRedirects.length === 0 ||
      !vendorRedirects.every(isHttpsUrl)
    ) {
      return null;
    }
    clients.push({ clientId, displayName, vendorRedirects: [...vendorRedirects] });
  }
  return clients;
}

function isHttpsUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('https://');
}
