/**
 * What a verified Privy access token is allowed to tell us.
 *
 * Deliberately four fields out of a larger payload. A claim that is not read
 * cannot be trusted by accident, and the ones left out are the ones that would
 * be tempting to trust: Privy's token carries no organization, no wallet and
 * no spend policy, and anything resembling those must be resolved from our own
 * tables. `McpSessionPort`'s docstring is the rule this implements — *"an
 * agent that could name its own `agentAccount` in a tool call would be
 * spending somebody else's balance"* — and a token is input like any other.
 */
export interface PrivyClaims {
  /** `sub` — the Privy DID (`did:privy:…`). The join key to `agents`. */
  readonly subject: string;

  /**
   * `sid` — Privy's session id, when present.
   *
   * Becomes `McpSession.credentialId`: it names *which* login is calling
   * without the token itself travelling into a log line, which is exactly what
   * that field is for. Falls back to the DID when a token carries no `sid`.
   */
  readonly sessionId: string | null;

  /** `exp`, as an instant. */
  readonly expiresAt: Date;

  /** `iat`, as an instant, when present. */
  readonly issuedAt: Date | null;
}

/** A single JWKS entry, narrowed to the one key type Privy signs with. */
export interface PrivyJwk {
  readonly kty: string;
  readonly crv?: string;
  readonly kid?: string;
  readonly use?: string;
  readonly alg?: string;
  readonly x?: string;
  readonly y?: string;
}

/**
 * The only signature algorithm accepted, checked against the token header
 * before a key is ever looked up.
 *
 * Pinned rather than read from the token: `alg` is attacker-controlled, and
 * accepting whatever it names is how `none` and HMAC-with-the-public-key
 * confusions work. Privy signs ES256 (P-256), which is also the only thing
 * `PrivyJwksCache` will import a key for.
 */
export const PRIVY_TOKEN_ALGORITHM = 'ES256';

/** P-256 signatures are `r ‖ s`, 32 bytes each, in the JWS encoding. */
export const ES256_SIGNATURE_BYTES = 64;
