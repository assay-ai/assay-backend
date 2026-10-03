import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  EgressHttpClient,
  UNTRUSTED_EGRESS_POLICY,
  isEgressError,
  withLimits,
} from '@shared/network/egress';

import { PRIVY_AUTH_CONFIG, PrivyAuthConfig } from '../domain/privy-auth.config';

/** What a lookup can tell us that a token cannot. */
export interface PrivyIdentityFacts {
  /** Base58 address of a linked Solana wallet, embedded one preferred. */
  readonly solanaAddress: string | null;
  /**
   * `0x` address of a linked EVM wallet, embedded one preferred.
   *
   * One Privy identity carries a wallet per namespace, and the caller
   * picks by the namespace of the chain it is linking on — reading only the
   * Solana one is how a base58 address came to be written under `eip155:46630`
   * on the first real EVM login.
   */
  readonly evmAddress: string | null;
  readonly email: string | null;
}

/**
 * Reads the linked accounts of a Privy identity.
 *
 * ## Why this exists at all
 *
 * A Privy access token carries a DID, a session id and nothing else. It does
 * not carry a wallet — and `McpSession.agentAccount`, the CAIP-10 account a
 * call is charged to, has exactly one honest source: an address the human
 * actually controls. Without this lookup a verified identity could log in and
 * never have an account, which makes the session useless for the one thing
 * sessions exist for.
 *
 * ## Why it is nowhere near the hot path
 *
 * Called only when an agent row has **no** `primary_account_id` — a first
 * login, and afterwards only until one is found. `AgentProvisioningService`
 * additionally holds a per-identity cooldown, so a client looping on an
 * unlinked account cannot turn its own logins into a request flood at Privy.
 * A resolved agent never reaches this class again.
 *
 * ## It fails soft, and that is the right direction here
 *
 * Every failure returns `null`. Login still succeeds; the account simply stays
 * unlinked and `AUTH_WALLET_NOT_LINKED` explains why the spending paths refuse.
 * The alternative — failing the login because a *secondary* enrichment call
 * did not answer — would make Privy's API availability a precondition for
 * reading a dashboard, which is the coupling `PrivyJwksCache` exists to avoid.
 *
 * ## The app secret
 *
 * Sent as HTTP Basic, from `PrivyAuthConfig`, and never logged, never put in
 * an error context and never returned. `EgressHttpClient` strips credential
 * headers across an origin change and this call follows no redirects at all.
 */
@Injectable()
export class PrivyUserDirectory {
  private readonly logger = new Logger(PrivyUserDirectory.name);

  constructor(
    private readonly egress: EgressHttpClient,
    @Inject(PRIVY_AUTH_CONFIG) private readonly config: PrivyAuthConfig,
  ) {}

  /** `null` when disabled, unconfigured, or the lookup did not answer usefully. */
  async lookup(privyUserId: string): Promise<PrivyIdentityFacts | null> {
    if (!this.config.userLookupEnabled) return null;

    if (!this.config.appSecret || !this.config.appId) {
      this.logger.warn(
        'Privy user lookup is enabled but PRIVY_APP_SECRET is not configured; ' +
          'agents will authenticate with no linked wallet',
      );
      return null;
    }

    const authorization = Buffer.from(`${this.config.appId}:${this.config.appSecret}`).toString(
      'base64',
    );

    try {
      const response = await this.egress.request({
        url: `${this.config.apiBaseUrl}/api/v1/users/${encodeURIComponent(privyUserId)}`,
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Basic ${authorization}`,
          'privy-app-id': this.config.appId,
        },
        policy: withLimits(UNTRUSTED_EGRESS_POLICY, {
          totalTimeoutMs: 5_000,
          headersTimeoutMs: 3_000,
          bodyTimeoutMs: 3_000,
          maxResponseBytes: 256 * 1024,
          // A redirect on a credential-bearing request is either a
          // misconfiguration or someone trying to collect the header.
          maxRedirects: 0,
        }),
      });

      if (response.status !== 200) {
        this.logger.warn(`Privy user lookup answered HTTP ${response.status}`);
        return null;
      }

      return readIdentityFacts(response.body);
    } catch (error) {
      this.logger.warn(
        `Privy user lookup failed (${describe(error)}); leaving the wallet unlinked`,
      );
      return null;
    }
  }
}

interface LinkedAccount {
  readonly type?: unknown;
  readonly address?: unknown;
  readonly chain_type?: unknown;
  readonly wallet_client_type?: unknown;
}

/**
 * Parsed defensively rather than cast.
 *
 * The response is a third party's JSON and the two fields taken from it end up
 * in a CAIP-10 identity and a `varchar(320)`. Anything unexpected yields
 * `null` for that field, which degrades to "not linked yet" — never to a
 * malformed account id written into `agents`.
 */
function readIdentityFacts(body: string): PrivyIdentityFacts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const accounts = (parsed as { linked_accounts?: unknown })?.linked_accounts;
  if (!Array.isArray(accounts)) return { solanaAddress: null, evmAddress: null, email: null };

  // An embedded wallet is the one the platform can later be granted a session
  // signer over; a linked external wallet is the user's own. Prefer the former
  // where both exist, and take a stable order rather than "whichever came
  // first in the array" so the same identity resolves the same way twice.
  const pick = (chainType: string, plausible: (value: unknown) => boolean): string | null => {
    const wallets = (accounts as LinkedAccount[]).filter(
      (account) =>
        account?.type === 'wallet' &&
        account.chain_type === chainType &&
        plausible(account.address),
    );
    const chosen = wallets.find((wallet) => wallet.wallet_client_type === 'privy') ?? wallets[0];
    return chosen ? (chosen.address as string) : null;
  };

  const email = (accounts as LinkedAccount[]).find(
    (account) => account?.type === 'email' && typeof account.address === 'string',
  );

  return {
    solanaAddress: pick('solana', isPlausibleSolanaAddress),
    evmAddress: pick('ethereum', isPlausibleEvmAddress),
    email: email ? String(email.address).slice(0, 320) : null,
  };
}

/** Base58, 32–44 characters. Enough to keep junk out of a CAIP-10 identity. */
function isPlausibleSolanaAddress(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

/** `0x` + 40 hex. The same job on the other namespace — shape only, no checksum. */
function isPlausibleEvmAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function describe(error: unknown): string {
  if (isEgressError(error)) {
    return `${error.code} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
