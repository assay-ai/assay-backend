/**
 * The limits every outbound call runs under, and the one knob that relaxes the
 * address check.
 *
 * The limits are not tuning parameters — they are the difference between a
 * hostile endpoint costing us one failed call and it costing us a worker.
 * The provider call runs on a BullMQ worker with
 * `WORKER_CONCURRENCY` slots; a provider that accepts a connection and then
 * dribbles one byte a minute forever occupies a slot forever, and four of them
 * take the whole worker. Every limit here exists to make that impossible, and
 * every one of them is enforced with a timer that is cleared in a `finally`.
 */

/** Time and size ceilings for a single outbound call, redirects included. */
export interface EgressLimits {
  /**
   * From "request written" to "response headers received", per hop.
   *
   * Covers DNS-to-connect-to-TLS-to-first-byte. A separate connect timeout
   * would add a knob without closing a gap.
   */
  readonly headersTimeoutMs: number;

  /**
   * From "response headers received" to "body complete", per hop.
   *
   * A **total** budget, not an idle one. Idle timeouts are what slow-drip
   * servers are built to defeat: one byte every `idle - 1`ms keeps an idle
   * timer alive indefinitely while delivering nothing.
   */
  readonly bodyTimeoutMs: number;

  /**
   * Wall-clock ceiling for the whole call including every redirect hop.
   *
   * Without this, the per-hop budgets multiply by `maxRedirects + 1` and the
   * real worst case is several times what either per-hop number suggests.
   */
  readonly totalTimeoutMs: number;

  /** Bytes of response body we are willing to buffer. Exceeding it aborts the socket. */
  readonly maxResponseBytes: number;

  /** How many `3xx` hops to follow. Each one is re-checked from scratch. */
  readonly maxRedirects: number;
}

/**
 * Whether blocked address ranges are refused.
 *
 * `PUBLIC_ONLY` is the default and the only value legitimate for a URL that
 * came from outside this system.
 */
export enum EgressTrust {
  /** Attacker-supplied URLs: provider endpoints, webhooks, anything user-typed. */
  PUBLIC_ONLY = 'PUBLIC_ONLY',

  /**
   * Operator-supplied URLs from environment configuration only.
   *
   * Exists for exactly one reason: our own facilitator and Kora run at
   * `127.0.0.1` in development and on private addresses in production, and
   * `PUBLIC_ONLY` would refuse to talk to them. It relaxes the *address* check
   * and nothing else — scheme, redirect re-checking, size, and every timeout
   * still apply, and the connection is still pinned to the resolved address.
   *
   * A URL that reached this process over HTTP, from a database row, or from a
   * provider must never be given this trust level. If you are reaching for it
   * for anything other than a value read from `process.env` at boot, the answer
   * is no.
   */
  INTERNAL_ALLOWED = 'INTERNAL_ALLOWED',
}

export interface EgressPolicy {
  readonly trust: EgressTrust;
  /** URL schemes permitted. `file:`, `gopher:`, `ftp:`, `data:` are absent on purpose. */
  readonly allowedProtocols: readonly string[];
  readonly limits: EgressLimits;
}

export const DEFAULT_EGRESS_LIMITS: EgressLimits = Object.freeze({
  headersTimeoutMs: 10_000,
  bodyTimeoutMs: 15_000,
  totalTimeoutMs: 30_000,
  maxResponseBytes: 5 * 1024 * 1024,
  maxRedirects: 3,
});

/**
 * The policy for anything whose URL we did not choose.
 *
 * Provider registration is **open with no approval**, so
 * "a URL we did not choose" is the normal case, not the exception. This is
 * therefore the default policy of the client, and a caller has to name
 * `INTERNAL_ALLOWED` explicitly to get anything weaker.
 */
export const UNTRUSTED_EGRESS_POLICY: EgressPolicy = Object.freeze({
  trust: EgressTrust.PUBLIC_ONLY,
  allowedProtocols: Object.freeze(['http:', 'https:']),
  limits: DEFAULT_EGRESS_LIMITS,
});

/** Our own services, addressed by a URL that came from `process.env`. */
export const INTERNAL_EGRESS_POLICY: EgressPolicy = Object.freeze({
  trust: EgressTrust.INTERNAL_ALLOWED,
  allowedProtocols: Object.freeze(['http:', 'https:']),
  limits: DEFAULT_EGRESS_LIMITS,
});

/**
 * The schemes a provider's binding endpoint may use.
 *
 * `https:` only in production: buyer arguments and provider replies — which
 * feed verdicts and stake consequences — must not travel in clear. Plain
 * `http:` stays allowed elsewhere so local and e2e stacks can serve bindings
 * from a local mock without a certificate.
 */
export function bindingEndpointProtocols(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): readonly string[] {
  return nodeEnv === 'production' ? ['https:'] : ['http:', 'https:'];
}

/** Narrow an existing policy without losing the parts nobody meant to change. */
export function withLimits(policy: EgressPolicy, limits: Partial<EgressLimits>): EgressPolicy {
  return Object.freeze({
    ...policy,
    limits: Object.freeze({ ...policy.limits, ...limits }),
  });
}
