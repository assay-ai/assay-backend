import { SessionSourceMode } from '@modules/auth/domain/session-source-mode';
import { loadMcpHostConfig } from '@modules/toolset/config/mcp-host.config';
import { takeOnceFromEnv } from '@modules/verification/signing/backends/env-key-source';

import { OAUTH_BUILTIN_CLIENT_PATH } from '../constants/oauth.constants';

/**
 * OAuth configuration (spec §5.2), read once per process that mounts the OAuth
 * routes or the OAuth session source. Every check below fails the boot: a
 * misconfigured authorization server must not start.
 *
 * `OAUTH_REQUEST_COOKIE_SECRET` is taken out of `process.env` through
 * `takeOnceFromEnv` (before anything can throw), and no error quotes it.
 */

/** An exact redirect URI the AS may send a browser to (§6.3.9 item 2). */
export interface OAuthRedirectAllowlistEntry {
  readonly uri: string;
  /** `true`: listed but not yet confirmed, so refused until cleared. */
  readonly review: boolean;
}

/** A client shown as "Verified" when it returns to one of its vendor redirects (§6.3.6). */
export interface OAuthVerifiedClient {
  readonly clientId: string;
  readonly displayName: string;
  readonly vendorRedirects: readonly string[];
}

export interface OAuthConfig {
  /** `MCP_PUBLIC_URL`: issuer, PRM `resource` root, access-token audience. */
  readonly issuer: string;
  /** `WEB_APP_URL`: where the consent page lives. */
  readonly webAppUrl: string;
  readonly verifiedClients: readonly OAuthVerifiedClient[];
  readonly redirectAllowlist: readonly OAuthRedirectAllowlistEntry[];
  /** Client ids whose grants may bind a payment key and use the API host (§6.3.13). */
  readonly paymentClients: readonly string[];
  /** e2e only: accept `http://localhost` CIMD client ids. Never in production. */
  readonly allowHttpCimdLoopback: boolean;
  /** Key for the pending-request browser cookie, at least 32 bytes. */
  readonly requestCookieSecret: Buffer;
}

export const OAUTH_CONFIG = Symbol('OAUTH_CONFIG');

export const OAUTH_VERIFIED_CLIENTS_ENV = 'OAUTH_VERIFIED_CLIENTS';
export const OAUTH_REDIRECT_ALLOWLIST_ENV = 'OAUTH_REDIRECT_ALLOWLIST';
export const OAUTH_PAYMENT_CLIENTS_ENV = 'OAUTH_PAYMENT_CLIENTS';
export const OAUTH_ALLOW_HTTP_CIMD_LOOPBACK_ENV = 'OAUTH_ALLOW_HTTP_CIMD_LOOPBACK';
export const OAUTH_REQUEST_COOKIE_SECRET_ENV = 'OAUTH_REQUEST_COOKIE_SECRET';

/**
 * §6.3.9 item 2. Only ChatGPT's callback is confirmed; the others stay
 * refused (`review: true`) until verified from staging traffic. The Cursor
 * value is UNVERIFIED.
 */
export const DEFAULT_OAUTH_REDIRECT_ALLOWLIST: readonly OAuthRedirectAllowlistEntry[] =
  Object.freeze([
    { uri: 'https://chatgpt.com/connector_platform_oauth_redirect', review: false },
    { uri: 'https://claude.ai/api/mcp/auth_callback', review: true },
    { uri: 'https://claude.com/api/mcp/auth_callback', review: true },
    { uri: 'https://vscode.dev/redirect', review: true },
    { uri: 'cursor://anysphere.cursor-mcp/oauth/callback', review: true },
  ]);

/** At least 32 random bytes, hex. */
const SECRET_SHAPE = /^(?:[0-9a-f]{2}){32,}$/i;

/**
 * Schemes that are never a private-use redirect: the web, scripts, local
 * content. Loopback `http:` is rule 1 of §6.3.9 and never an allowlist entry.
 */
const NON_PRIVATE_SCHEMES = new Set([
  'http:',
  'javascript:',
  'data:',
  'file:',
  'blob:',
  'about:',
  'vbscript:',
  'ws:',
  'wss:',
  'ftp:',
  'mailto:',
]);

export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  // First, so the secret leaves the environment even when a check below throws.
  const [requestCookieSecret] = takeOnceFromEnv(env, OAUTH_REQUEST_COOKIE_SECRET_ENV, (raw) => {
    const value = raw.trim();
    if (!SECRET_SHAPE.test(value)) {
      throw new Error(
        `${OAUTH_REQUEST_COOKIE_SECRET_ENV} must be at least 32 random bytes, hex-encoded`,
      );
    }
    return [Buffer.from(value, 'hex')];
  });

  if (env.AUTH_SESSION_SOURCE !== SessionSourceMode.BOTH) {
    throw new Error(
      `AUTH_SESSION_SOURCE must be "${SessionSourceMode.BOTH}" where the OAuth routes run: ` +
        'the consent API needs the Privy source',
    );
  }

  const production = env.NODE_ENV === 'production';
  const host = loadMcpHostConfig(env);
  if (production) {
    requireHttps('MCP_PUBLIC_URL', host.mcpPublicUrl);
    requireHttps('WEB_APP_URL', host.webAppUrl);
  }

  if (!requestCookieSecret) {
    throw new Error(`${OAUTH_REQUEST_COOKIE_SECRET_ENV} is required where the OAuth routes run`);
  }

  const allowHttpCimdLoopback = parseBoolean(
    OAUTH_ALLOW_HTTP_CIMD_LOOPBACK_ENV,
    env[OAUTH_ALLOW_HTTP_CIMD_LOOPBACK_ENV],
  );
  if (allowHttpCimdLoopback && production) {
    throw new Error(
      `${OAUTH_ALLOW_HTTP_CIMD_LOOPBACK_ENV} must not be true when NODE_ENV=production`,
    );
  }

  const redirectAllowlist = parseRedirectAllowlist(env[OAUTH_REDIRECT_ALLOWLIST_ENV]);
  const verifiedClients = parseVerifiedClients(env[OAUTH_VERIFIED_CLIENTS_ENV], redirectAllowlist);
  const paymentClients = parsePaymentClients(
    env[OAUTH_PAYMENT_CLIENTS_ENV],
    `${host.mcpPublicUrl}${OAUTH_BUILTIN_CLIENT_PATH}`,
  );

  return Object.freeze({
    issuer: host.mcpPublicUrl,
    webAppUrl: host.webAppUrl,
    verifiedClients,
    redirectAllowlist,
    paymentClients,
    allowHttpCimdLoopback,
    requestCookieSecret,
  });
}

function requireHttps(name: string, value: string): void {
  if (new URL(value).protocol !== 'https:') {
    throw new Error(`${name} must be an https URL when NODE_ENV=production`);
  }
}

function parseBoolean(name: string, raw: string | undefined): boolean {
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be "true" or "false"`);
}

function parseJson(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function parseRedirectAllowlist(raw: string | undefined): readonly OAuthRedirectAllowlistEntry[] {
  if (!raw?.trim()) return DEFAULT_OAUTH_REDIRECT_ALLOWLIST;
  const name = OAUTH_REDIRECT_ALLOWLIST_ENV;
  const parsed = parseJson(name, raw);
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array of {uri, review}`);

  return Object.freeze(
    parsed.map((entry: unknown, index) => {
      const { uri, review } = (entry ?? {}) as { uri?: unknown; review?: unknown };
      if (!isNonEmptyString(uri) || typeof review !== 'boolean') {
        throw new Error(`${name}[${index}] must be {uri: string, review: boolean}`);
      }
      const problem = redirectUriProblem(uri);
      if (problem) throw new Error(`${name}[${index}] "${uri}": ${problem}`);
      return Object.freeze({ uri, review });
    }),
  );
}

/**
 * Why `uri` cannot be an allowlist entry, or `null`. Exact `https:` URIs and
 * private-use schemes only (§6.3.9): no wildcard, query or fragment.
 */
function redirectUriProblem(uri: string): string | null {
  if (uri.includes('*')) return 'no wildcard is allowed';
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return 'not a URI';
  }
  if (parsed.search || uri.includes('?')) return 'no query is allowed';
  if (parsed.hash || uri.includes('#')) return 'no fragment is allowed';
  if (parsed.username || parsed.password) return 'no userinfo is allowed';
  if (parsed.protocol === 'https:') return parsed.hostname ? null : 'an https URI needs a host';
  if (NON_PRIVATE_SCHEMES.has(parsed.protocol)) {
    return 'only an exact https URI or a private-use scheme is allowed';
  }
  return null;
}

function parseVerifiedClients(
  raw: string | undefined,
  allowlist: readonly OAuthRedirectAllowlistEntry[],
): readonly OAuthVerifiedClient[] {
  if (!raw?.trim()) return Object.freeze([]);
  const name = OAUTH_VERIFIED_CLIENTS_ENV;
  const parsed = parseJson(name, raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array of {clientId, displayName, vendorRedirects}`);
  }
  const cleared = new Set(allowlist.filter((entry) => !entry.review).map((entry) => entry.uri));

  return Object.freeze(
    parsed.map((entry: unknown, index) => {
      const { clientId, displayName, vendorRedirects } = (entry ?? {}) as Record<string, unknown>;
      if (
        !isNonEmptyString(clientId) ||
        !isNonEmptyString(displayName) ||
        !Array.isArray(vendorRedirects) ||
        vendorRedirects.length === 0 ||
        !vendorRedirects.every(isNonEmptyString)
      ) {
        throw new Error(
          `${name}[${index}] must be {clientId: string, displayName: string, vendorRedirects: string[]}`,
        );
      }
      for (const uri of vendorRedirects) {
        if (!cleared.has(uri)) {
          throw new Error(
            `${name}[${index}] vendor redirect "${uri}" is not in ${OAUTH_REDIRECT_ALLOWLIST_ENV} with review: false`,
          );
        }
        if (!uri.startsWith('https://')) {
          throw new Error(`${name}[${index}] vendor redirect "${uri}" must be an https URI`);
        }
      }
      return Object.freeze({
        clientId,
        displayName,
        vendorRedirects: Object.freeze([...vendorRedirects]),
      });
    }),
  );
}

function parsePaymentClients(raw: string | undefined, builtin: string): readonly string[] {
  if (!raw?.trim()) return Object.freeze([builtin]);
  const name = OAUTH_PAYMENT_CLIENTS_ENV;
  const parsed = parseJson(name, raw);
  if (!Array.isArray(parsed) || !parsed.every(isNonEmptyString)) {
    throw new Error(`${name} must be a JSON array of client id strings`);
  }
  return Object.freeze([...parsed]);
}
