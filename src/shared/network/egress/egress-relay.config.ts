import { isIP } from 'node:net';

import { takeOnceFromEnv } from '@modules/verification/signing/backends/env-key-source';

/**
 * Where provider calls leave from, when they do not leave from this server.
 *
 * `EGRESS_RELAY_URL` is operator configuration (a Cloudflare Worker, see
 * `workers/egress-relay/`). `EGRESS_RELAY_TOKEN` is its bearer secret: read once
 * and deleted from `process.env` through `takeOnceFromEnv`, and never quoted in
 * a log line or an error.
 */
export interface EgressRelayConfig {
  readonly url: URL;
  readonly token: string;
}

/** `EgressRelayConfig | null` — `null` means provider calls go direct. */
export const EGRESS_RELAY_CONFIG = Symbol('EGRESS_RELAY_CONFIG');

/**
 * Ports the relay Worker can fetch (Cloudflare's allowed HTTPS ports).
 * Must match `RELAY_ALLOWED_PORTS` in `workers/egress-relay/src/relay.ts`.
 */
export const RELAY_ALLOWED_PORTS: readonly number[] = Object.freeze([
  443, 8443, 2053, 2083, 2087, 2096,
]);

export const EGRESS_RELAY_URL_ENV = 'EGRESS_RELAY_URL';
export const EGRESS_RELAY_TOKEN_ENV = 'EGRESS_RELAY_TOKEN';

/** At least 32 random bytes, hex. */
const TOKEN_SHAPE = /^[0-9a-f]{64,}$/i;

/**
 * Read the relay configuration, taking the token out of the environment.
 *
 * The token is taken even when the URL is unset, so a stray secret never
 * survives in `process.env`. Errors name the variable and never its value.
 */
export function takeEgressRelayConfig(env: NodeJS.ProcessEnv): EgressRelayConfig | null {
  const [token] = takeOnceFromEnv(env, EGRESS_RELAY_TOKEN_ENV, (raw) => [raw.trim()]);
  const rawUrl = env[EGRESS_RELAY_URL_ENV]?.trim();
  if (!rawUrl) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${EGRESS_RELAY_URL_ENV} is not a valid URL`);
  }
  const httpAllowed = env.NODE_ENV !== 'production' && url.protocol === 'http:';
  if (url.protocol !== 'https:' && !httpAllowed) {
    throw new Error(`${EGRESS_RELAY_URL_ENV} must be an https URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${EGRESS_RELAY_URL_ENV} must not carry credentials`);
  }

  if (!token) {
    throw new Error(`${EGRESS_RELAY_TOKEN_ENV} is required when ${EGRESS_RELAY_URL_ENV} is set`);
  }
  if (!TOKEN_SHAPE.test(token)) {
    throw new Error(`${EGRESS_RELAY_TOKEN_ENV} must be at least 32 random bytes, hex-encoded`);
  }

  return Object.freeze({ url, token });
}

/**
 * Whether `hostname` (as `URL.hostname` gives it, IPv6 in brackets) is an IP
 * literal. The relay refuses those: it fetches by host name only. Shared by the
 * transport's pre-check and the save-time checks so the two cannot drift.
 */
export function isIpLiteralHost(hostname: string): boolean {
  return isIP(hostname.replace(/^\[|\]$/g, '')) !== 0;
}
