import {
  OAuthClientEntity,
  OAuthClientKind,
} from '@database/postgres/entities/oauth-client.entity';

import { isPaymentClient } from './payment-client';
import { registrableDomain } from './registrable-domain';

/** A client listed in `OAUTH_VERIFIED_CLIENTS`, as far as the credentials list needs it. */
export interface CredentialVerifiedClient {
  readonly clientId: string;
  readonly displayName: string;
  readonly vendorRedirects: readonly string[];
}

/** What the credentials list needs to know to describe a grant's client. */
export interface OAuthClientTrust {
  /**
   * The parsed `OAUTH_PAYMENT_CLIENTS` (`parsePaymentClientsEnv`), the same
   * list delegate binding reads: only the built-in `assay-mcp` client today.
   */
  readonly paymentClients: readonly string[];
  readonly verifiedClients: readonly CredentialVerifiedClient[];
}

export const OAUTH_CLIENT_TRUST = Symbol('OAUTH_CLIENT_TRUST');

/** `AgentCredentialDto.oauthClient` (spec §7.10 item 4). */
export interface CredentialOAuthClientView {
  readonly clientId: string;
  readonly name: string;
  /** eTLD+1 of a CIMD client's host; `null` when no domain is proven (DCR, built-in). */
  readonly registrableDomain: string | null;
  readonly verified: boolean;
  readonly paymentClient: boolean;
}

/**
 * How the credentials list describes the client a grant was issued to.
 *
 * "Verified" on the consent page depends on the request's `redirect_uri`
 * (§6.3.6). A credential does not keep the redirect it was approved for (its
 * code row is deleted a day later), so here a client is verified only when it
 * is a listed CIMD client and **every** redirect it registers is one of its
 * vendor redirects: then any grant it holds returned to one of them. A listed
 * client that also registers a loopback or private-use redirect is not
 * verified, because its grant may have gone there. The built-in client always
 * returns to loopback, so it is never verified.
 *
 * `paymentClient`: {@link isPaymentClient} on the parsed
 * `OAUTH_PAYMENT_CLIENTS`, the predicate and list delegate binding uses, so
 * the two cannot disagree.
 *
 * Drift, accepted: "verified" reads the client's current redirects, not the
 * ones it had when the grant was approved. A CIMD document that later drops
 * a non-vendor redirect makes an older grant show as verified. Display only.
 */
export function credentialClientView(
  client: Pick<OAuthClientEntity, 'clientId' | 'kind' | 'clientName' | 'redirectUris'>,
  trust: OAuthClientTrust,
): CredentialOAuthClientView {
  const isCimd = client.kind === OAuthClientKind.CIMD;
  const listed = isCimd
    ? trust.verifiedClients.find((entry) => entry.clientId === client.clientId)
    : undefined;
  const verified =
    listed !== undefined &&
    client.redirectUris.length > 0 &&
    client.redirectUris.every((uri) => listed.vendorRedirects.includes(uri));

  return {
    clientId: client.clientId,
    name: verified ? listed.displayName : client.clientName,
    registrableDomain: isCimd ? cimdDomain(client.clientId) : null,
    verified,
    paymentClient: isPaymentClient(trust.paymentClients, client),
  };
}

function cimdDomain(clientId: string): string | null {
  try {
    return registrableDomain(new URL(clientId).hostname)?.registrable ?? null;
  } catch {
    return null;
  }
}
