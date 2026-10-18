import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';

import {
  OAuthClientEntity,
  OAuthClientKind,
} from '@database/postgres/entities/oauth-client.entity';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { APP_ROLE, AppRole, resolveAppRole } from '@shared/app-role/app-role';

import { OAUTH_CONFIG, OAuthConfig } from '../config/oauth.config';
import { builtinClientDocument } from '../domain/builtin-client';
import { classify } from '../domain/client-id';
import { isPaymentClient } from '../domain/payment-client';
import { matches } from '../domain/redirect-uri';
import { registrableDomain } from '../domain/registrable-domain';
import { CimdFetcher } from './cimd.fetcher';

const LOCAL_APP_DISPLAY = 'an app on this computer';

/** A client the authorization server knows, as `/oauth/authorize` and consent use it. */
export interface ResolvedClient {
  /** `oauth_clients.id`: what credentials and codes reference. */
  readonly id: string;
  readonly clientId: string;
  readonly kind: OAuthClientKind;
  /** The client's own (sanitised) name: self-declared, never proof of anything. */
  readonly name: string;
  /** Text only, never a link. */
  readonly clientUri: string | null;
  readonly redirectUris: readonly string[];
  /** Set when the client is listed in `OAUTH_VERIFIED_CLIENTS`. */
  readonly verifiedDisplayName: string | null;
  /** The listed entry's vendor redirects; empty when not listed. */
  readonly vendorRedirects: readonly string[];
}

export type ClientResolveError = 'client_unknown' | 'client_metadata_invalid';

/** What the consent page shows about a client for one request (§6.3.5, §6.3.6, R-OA-25). */
export interface ClientDisplay {
  readonly name: string;
  readonly verified: boolean;
  readonly builtin: boolean;
  /** eTLD+1 of the CIMD document's host; `null` when no domain is proven (DCR, built-in). */
  readonly registrableDomain: string | null;
  readonly host: string | null;
  readonly returnTo: { readonly kind: 'WEB' | 'LOCAL_APP'; readonly display: string };
}

/**
 * Resolves a `client_id` to a client (spec §6.3.6) and says how the consent
 * page presents it.
 *
 * ```text
 * {MCP}/oauth/clients/assay-mcp   BUILTIN, upserted at boot, resolved in process
 * dcr_ + 22 base64url             DCR row; absent → client_unknown
 * https URL (§6.3.7)              CIMD, via CimdFetcher; bad → client_metadata_invalid
 * anything else                   client_unknown
 * ```
 *
 * "Verified" needs both halves: the client is listed in
 * `OAUTH_VERIFIED_CLIENTS`, **and** this request's `redirect_uri` is one of
 * that entry's vendor redirects. A listed client returning to loopback or a
 * private-use scheme could be any local process, so it is not verified; the
 * built-in client always returns to loopback, so it is never verified.
 */
@Injectable()
export class OAuthClientRegistry implements OnModuleInit {
  private readonly logger = new Logger(OAuthClientRegistry.name);
  private builtin: ResolvedClient | null = null;

  constructor(
    private readonly clients: OAuthClientRepository,
    private readonly cimd: CimdFetcher,
    @Inject(OAUTH_CONFIG) private readonly config: OAuthConfig,
    @Optional() @Inject(APP_ROLE) private readonly role?: AppRole,
  ) {}

  async onModuleInit(): Promise<void> {
    const document = builtinClientDocument(this.config.issuer);
    const row = await this.clients.upsertByClientId({
      clientId: document.client_id,
      kind: OAuthClientKind.BUILTIN,
      clientName: document.client_name,
      clientUri: null,
      redirectUris: document.redirect_uris,
      metadata: document,
      fetchedAt: null,
      cacheUntil: null,
    });
    if (!row) {
      throw new Error(
        `oauth_clients already holds ${document.client_id} as a non-BUILTIN client; refusing to boot`,
      );
    }
    this.builtin = this.toResolved(row);
    // Only the MCP app resolves client ids (`/oauth/authorize`), so only it
    // fetches. The API app reads stored rows and makes no outbound call.
    if (resolveAppRole(this.role) !== 'mcp') return;
    // Not awaited: a slow or failing vendor host must not hold up the boot.
    void this.prewarm();
  }

  /**
   * Fetch the `OAUTH_VERIFIED_CLIENTS` documents now, so their first
   * authorization does not wait on a fetch. Exempt from the budgets; a
   * failure is logged and retried on first use.
   */
  async prewarm(): Promise<void> {
    await Promise.all(
      this.config.verifiedClients.map(async ({ clientId }) => {
        if (this.kindOf(clientId) !== 'CIMD') return;
        try {
          const outcome = await this.cimd.fetch(clientId, 'prewarm');
          if (!outcome.ok) this.logger.warn(`pre-warm of verified client ${clientId} failed`);
        } catch (error) {
          this.logger.warn(
            `pre-warm of verified client ${clientId} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  }

  async resolve(
    clientId: string,
    ipKey: string,
  ): Promise<ResolvedClient | { error: ClientResolveError }> {
    switch (this.kindOf(clientId)) {
      case 'BUILTIN': {
        if (this.builtin) return this.builtin;
        const row = await this.clients.findByClientId(clientId);
        return row?.kind === OAuthClientKind.BUILTIN
          ? this.toResolved(row)
          : { error: 'client_unknown' };
      }
      case 'DCR': {
        const row = await this.clients.findByClientId(clientId);
        return row?.kind === OAuthClientKind.DCR
          ? this.toResolved(row)
          : { error: 'client_unknown' };
      }
      case 'CIMD': {
        const outcome = await this.cimd.fetch(clientId, ipKey);
        return outcome.ok ? this.toResolved(outcome.client) : { error: 'client_metadata_invalid' };
      }
      default:
        return { error: 'client_unknown' };
    }
  }

  /**
   * The client a pending request or a grant names by its row id
   * (`oauth_clients.id`), as stored: no fetch. `null` if the row is gone.
   */
  async findById(id: string): Promise<ResolvedClient | null> {
    const row = await this.clients.findOne({ where: { id } });
    return row ? this.toResolved(row) : null;
  }

  /** Whether grants of `clientId` may bind a payment key and use the API host (§6.3.13). */
  isPaymentClient(clientId: string): boolean {
    return isPaymentClient(this.config.paymentClients, clientId);
  }

  displayFor(client: ResolvedClient, redirectUri: string): ClientDisplay {
    const builtin = client.kind === OAuthClientKind.BUILTIN;
    // Self-contained: never verified for a redirect this client did not register.
    const verified =
      !builtin &&
      client.kind === OAuthClientKind.CIMD &&
      client.verifiedDisplayName !== null &&
      client.vendorRedirects.includes(redirectUri) &&
      matches(client.redirectUris, redirectUri, this.config.redirectAllowlist);

    let host: string | null = null;
    let domain: string | null = null;
    if (client.kind === OAuthClientKind.CIMD) {
      host = new URL(client.clientId).hostname;
      domain = registrableDomain(host)?.registrable ?? null;
    }

    return {
      name: verified ? client.verifiedDisplayName! : client.name,
      verified,
      builtin,
      registrableDomain: domain,
      host,
      returnTo: returnTo(redirectUri),
    };
  }

  private kindOf(clientId: string) {
    return classify(clientId, {
      mcpPublicUrl: this.config.issuer,
      allowHttpLoopback: this.config.allowHttpCimdLoopback,
    }).kind;
  }

  private toResolved(row: OAuthClientEntity): ResolvedClient {
    // Only a CIMD client can be listed: its domain is proven by serving the document.
    const listed =
      row.kind === OAuthClientKind.CIMD
        ? this.config.verifiedClients.find((entry) => entry.clientId === row.clientId)
        : undefined;
    return Object.freeze({
      id: row.id,
      clientId: row.clientId,
      kind: row.kind,
      name: row.clientName,
      clientUri: row.clientUri,
      redirectUris: Object.freeze([...row.redirectUris]),
      verifiedDisplayName: listed?.displayName ?? null,
      vendorRedirects: listed?.vendorRedirects ?? Object.freeze([]),
    });
  }
}

/** Where the browser goes after consent: a web origin, or an app on this computer. */
function returnTo(redirectUri: string): ClientDisplay['returnTo'] {
  if (redirectUri.startsWith('https://')) {
    try {
      return { kind: 'WEB', display: new URL(redirectUri).hostname };
    } catch {
      // Not reachable for a URI that passed §6.3.9; shown as local rather than guessed.
    }
  }
  // Loopback and private-use schemes: any local process could be listening.
  return { kind: 'LOCAL_APP', display: LOCAL_APP_DISPLAY };
}
