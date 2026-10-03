/**
 * Everything the Privy services need, injected as one frozen value.
 *
 * Same shape as `WEBHOOK_ALERT_SINK_CONFIG`: the module reads `ConfigService`
 * once and binds the result, so no service reaches into `process.env` and
 * every one of them is constructible in a test with a literal. `appSecret` is
 * a credential and reaches this object from `src/config/auth.config.ts` — it
 * is never read at a call site and never appears in a message, a log line or
 * an error context.
 */
export interface PrivyAuthConfig {
  /** Privy application id. Also the `aud` every token must carry. */
  readonly appId: string;

  /**
   * Used for exactly one thing: the authenticated user lookup that turns a DID
   * into a linked wallet address. **Never** used to verify a token — that is
   * local, against the JWKS.
   */
  readonly appSecret: string | null;

  readonly apiBaseUrl: string;

  /** Expected `iss`. Privy signs `privy.io`. */
  readonly issuer: string;

  readonly jwksUrl: string;

  /** How long a fetched key set is fresh. */
  readonly jwksTtlMs: number;

  /** How much longer a stale set may be used when a refresh fails. */
  readonly jwksStaleGraceMs: number;

  /** Floor between two refreshes forced by an unrecognised `kid`. */
  readonly jwksMinRefreshMs: number;

  /** Tolerance applied to `exp` / `iat` / `nbf`, both directions. */
  readonly clockSkewMs: number;

  /** CAIP-2 chain a Privy-authenticated agent's money settles on. */
  readonly defaultChainId: string;

  /** Whether a first login may ask Privy which wallets the identity has linked. */
  readonly userLookupEnabled: boolean;
}

/** DI token for the bound {@link PrivyAuthConfig}. */
export const PRIVY_AUTH_CONFIG = 'PRIVY_AUTH_CONFIG';
