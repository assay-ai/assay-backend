import { Logger } from '@nestjs/common';

import { CredentialVerifiedClient, OAuthClientTrust } from '../domain/credential-client-view';
import {
  OAUTH_PAYMENT_CLIENTS_ENV,
  OAUTH_VERIFIED_CLIENTS_ENV,
  parsePaymentClientsEnv,
  parseVerifiedClientsEnv,
} from './oauth.config';

const logger = new Logger('OAuthClientTrust');

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
 * The same parser and checks as `loadOAuthConfig` (`parseVerifiedClientsEnv`):
 * an https CIMD `clientId`, and every vendor redirect in
 * `OAUTH_REDIRECT_ALLOWLIST` with `review: false`. Fails closed: a value that
 * does not pass returns `null`, logged once, and the caller shows no client as
 * verified.
 */
export function readVerifiedClients(
  env: NodeJS.ProcessEnv,
  mcpPublicUrl: string,
): CredentialVerifiedClient[] | null {
  try {
    return parseVerifiedClientsEnv(env, mcpPublicUrl).map((client) => ({
      clientId: client.clientId,
      displayName: client.displayName,
      vendorRedirects: [...client.vendorRedirects],
    }));
  } catch (error) {
    logger.warn(
      `${OAUTH_VERIFIED_CLIENTS_ENV} is invalid; no OAuth client is shown as verified. ` +
        messageOf(error),
    );
    return null;
  }
}

/**
 * `OAUTH_PAYMENT_CLIENTS` through the same parser as `loadOAuthConfig`
 * (`parsePaymentClientsEnv`), so the credentials list's `paymentClient` reads
 * the list delegate binding reads. Fails closed: an invalid value (which also
 * fails the boot of the OAuth processes) returns `null`, logged once, and no
 * client is shown as a payment client.
 */
export function readPaymentClients(
  env: NodeJS.ProcessEnv,
  mcpPublicUrl: string,
): readonly string[] | null {
  try {
    return parsePaymentClientsEnv(env, mcpPublicUrl);
  } catch (error) {
    logger.warn(
      `${OAUTH_PAYMENT_CLIENTS_ENV} is invalid; no OAuth client is shown as a payment client. ` +
        messageOf(error),
    );
    return null;
  }
}

/** `OAUTH_CLIENT_TRUST` for the credentials list; never throws. */
export function readOAuthClientTrust(
  env: NodeJS.ProcessEnv,
  mcpPublicUrl: string,
): OAuthClientTrust {
  return {
    paymentClients: readPaymentClients(env, mcpPublicUrl) ?? [],
    verifiedClients: readVerifiedClients(env, mcpPublicUrl) ?? [],
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
