/**
 * Which credential issuer a deployment trusts. `AUTH_SESSION_SOURCE`.
 *
 * Both sources implement `McpSessionPort` and both fail closed, so this is a
 * question about *which secrets are accepted*, not about how strictly they are
 * checked.
 */
export enum SessionSourceMode {
  /**
   * `MCP_CREDENTIALS_FILE` only — the demo tokens. The default, because it is
   * what every existing test, seed and local stack already presents.
   */
  CONFIG = 'config',

  /** Privy access tokens only. The end state. */
  PRIVY = 'privy',

  /**
   * `agent_credentials` tokens only (`assay_sk_live_…`) — the credential a
   * user creates in the UI, read through
   * `DbCredentialMcpSessionSource`.
   */
  DB = 'db',

  /**
   * All three, config first, then db, then Privy.
   *
   * The migration position: a deployment that has real users and still runs
   * the demo seed. Order is a latency decision and not a security one — the
   * config check is an in-memory constant-time scan over a handful of digests,
   * so putting it first costs a Privy caller nothing measurable and saves a
   * config caller a signature verification. `db` sits ahead of `privy` for
   * the same reason: a rejected `assay_sk_live_…` prefix is cheaper than a
   * signature verification, and neither source can admit a token another
   * source would have refused.
   */
  BOTH = 'both',
}

export function parseSessionSourceMode(raw: string | undefined): SessionSourceMode {
  switch (raw) {
    case SessionSourceMode.PRIVY:
      return SessionSourceMode.PRIVY;
    case SessionSourceMode.DB:
      return SessionSourceMode.DB;
    case SessionSourceMode.BOTH:
      return SessionSourceMode.BOTH;
    default:
      // Including `undefined` and anything unrecognised. `auth.config.ts`
      // rejects an unrecognised value at boot; this branch is what keeps a
      // *missing* one meaning "nothing changed" rather than "no source".
      return SessionSourceMode.CONFIG;
  }
}
