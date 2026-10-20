import { SessionSourceMode } from '@modules/auth/domain/session-source-mode';
import { AppRole } from '@shared/app-role/app-role';
import { isLocalDeployment } from '@modules/mcp/config/mcp-discovery.config';
import { loadMcpHostConfig } from '@modules/toolset/config/mcp-host.config';
import { takeOnceFromEnv } from '@modules/verification/signing/backends/env-key-source';

import { builtinClientId } from '../domain/client-id';
import { classify } from '../domain/client-id';

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
  /**
   * Key for the pending-request browser cookie, at least 32 bytes. `null` on
   * the API app, which never uses it; whatever uses it must refuse a `null`.
   */
  readonly requestCookieSecret: Buffer | null;
  /** DCR registrations per UTC day, all clients together (§6.3.8). */
  readonly dcrGlobalPerDay: number;
  /** DCR registration attempts per hour from one IPv6 /48 (§6.3.8). */
  readonly dcrPer48PerHour: number;
}

export const OAUTH_CONFIG = Symbol('OAUTH_CONFIG');

export const OAUTH_VERIFIED_CLIENTS_ENV = 'OAUTH_VERIFIED_CLIENTS';
export const OAUTH_REDIRECT_ALLOWLIST_ENV = 'OAUTH_REDIRECT_ALLOWLIST';
export const OAUTH_PAYMENT_CLIENTS_ENV = 'OAUTH_PAYMENT_CLIENTS';
export const OAUTH_ALLOW_HTTP_CIMD_LOOPBACK_ENV = 'OAUTH_ALLOW_HTTP_CIMD_LOOPBACK';
export const OAUTH_REQUEST_COOKIE_SECRET_ENV = 'OAUTH_REQUEST_COOKIE_SECRET';
export const OAUTH_DCR_GLOBAL_PER_DAY_ENV = 'OAUTH_DCR_GLOBAL_PER_DAY';
export const OAUTH_DCR_PER_48_PER_HOUR_ENV = 'OAUTH_DCR_PER_48_PER_HOUR';

/** Defaults pending the owner's numbers (review of Task 1.5, I1). */
export const DEFAULT_OAUTH_DCR_GLOBAL_PER_DAY = 1000;
export const DEFAULT_OAUTH_DCR_PER_48_PER_HOUR = 50;

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
/** A random 32-byte key has ~25 distinct bytes; fewer than this is not random. */
const MIN_DISTINCT_SECRET_BYTES = 16;

/** RFC 8252 §7.1: a private-use scheme is a reverse domain name, so it has a dot. */
const REVERSE_DOMAIN_SCHEME = /^[a-z][a-z0-9+-]*(?:\.[a-z0-9+-]+)+:$/;

/** Vendor schemes without a dot, admitted by name (the §6.3.9 Cursor default). */
const NAMED_PRIVATE_SCHEMES: ReadonlySet<string> = new Set(['cursor:', 'vscode:']);

/**
 * `role` is the container's `APP_ROLE`. Only the MCP app serves
 * `/oauth/authorize` and `continue`, the two places that use the request
 * cookie, so only it reads and requires `OAUTH_REQUEST_COOKIE_SECRET`. The
 * API app (the consent API) never reads it, so it boots without it and holds
 * no copy; there `requestCookieSecret` is `null`. Under `SERVICE_TYPE=all` the
 * MCP container still takes it out of the shared environment.
 */
export function loadOAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  role: AppRole = 'mcp',
): OAuthConfig {
  const servesAuthorize = role === 'mcp';
  // First, so the secret leaves the environment even when a check below throws.
  const [requestCookieSecret] = servesAuthorize ? readRequestCookieSecret(env) : [];

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

  if (servesAuthorize && !requestCookieSecret) {
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
  // Outside a local run the flag would let a stranger make this server GET any
  // http://localhost port: refuse it on any internet-facing deployment.
  if (allowHttpCimdLoopback && !isLocalDeployment(env)) {
    throw new Error(
      `${OAUTH_ALLOW_HTTP_CIMD_LOOPBACK_ENV} is for a local run only ` +
        '(NODE_ENV local or test, or a localhost MCP_PUBLIC_URL)',
    );
  }

  const redirectAllowlist = parseRedirectAllowlist(env[OAUTH_REDIRECT_ALLOWLIST_ENV]);
  const verifiedClients = parseVerifiedClients(
    env[OAUTH_VERIFIED_CLIENTS_ENV],
    redirectAllowlist,
    host.mcpPublicUrl,
  );
  // One derivation of the audience and the payment clients, shared with the
  // session source: a drift would refuse every token or change who may pay.
  const session = loadOAuthSessionConfig(env);

  return Object.freeze({
    issuer: session.audience,
    webAppUrl: host.webAppUrl,
    verifiedClients,
    redirectAllowlist,
    paymentClients: session.paymentClients,
    allowHttpCimdLoopback,
    requestCookieSecret: requestCookieSecret ?? null,
    dcrGlobalPerDay: parsePositiveInt(
      OAUTH_DCR_GLOBAL_PER_DAY_ENV,
      env[OAUTH_DCR_GLOBAL_PER_DAY_ENV],
      DEFAULT_OAUTH_DCR_GLOBAL_PER_DAY,
    ),
    dcrPer48PerHour: parsePositiveInt(
      OAUTH_DCR_PER_48_PER_HOUR_ENV,
      env[OAUTH_DCR_PER_48_PER_HOUR_ENV],
      DEFAULT_OAUTH_DCR_PER_48_PER_HOUR,
    ),
  });
}

/**
 * `OAUTH_VERIFIED_CLIENTS`, validated exactly as {@link loadOAuthConfig} does
 * (with `OAUTH_REDIRECT_ALLOWLIST`, which its vendor redirects must be in).
 * Throws on any problem. For a process that needs the list without the rest
 * of `OAUTH_CONFIG` (the credentials list, through `readOAuthClientTrust`).
 */
export function parseVerifiedClientsEnv(
  env: NodeJS.ProcessEnv,
  mcpPublicUrl: string,
): readonly OAuthVerifiedClient[] {
  return parseVerifiedClients(
    env[OAUTH_VERIFIED_CLIENTS_ENV],
    parseRedirectAllowlist(env[OAUTH_REDIRECT_ALLOWLIST_ENV]),
    mcpPublicUrl,
  );
}

/**
 * `OAUTH_PAYMENT_CLIENTS`, validated as {@link loadOAuthConfig} does: the one
 * source of the payment-client list, for the OAuth session source (through
 * {@link loadOAuthSessionConfig}), `OAuthClientRegistry.isPaymentClient`
 * (through `OAUTH_CONFIG`) and the credentials list's `paymentClient` (through
 * `readOAuthClientTrust`). Throws on any problem.
 */
export function parsePaymentClientsEnv(
  env: NodeJS.ProcessEnv,
  mcpPublicUrl: string,
): readonly string[] {
  return parsePaymentClients(env[OAUTH_PAYMENT_CLIENTS_ENV], builtinClientId(mcpPublicUrl));
}

function readRequestCookieSecret(env: NodeJS.ProcessEnv): readonly Buffer[] {
  return takeOnceFromEnv(env, OAUTH_REQUEST_COOKIE_SECRET_ENV, (raw) => {
    const value = raw.trim();
    if (!SECRET_SHAPE.test(value)) {
      throw new Error(
        `${OAUTH_REQUEST_COOKIE_SECRET_ENV} must be at least 32 random bytes, hex-encoded`,
      );
    }
    const secret = Buffer.from(value, 'hex');
    if (new Set(secret).size < MIN_DISTINCT_SECRET_BYTES) {
      throw new Error(
        `${OAUTH_REQUEST_COOKIE_SECRET_ENV} is not random; generate one with openssl rand -hex 32`,
      );
    }
    return [secret];
  });
}

/**
 * The two values the OAuth session source needs (spec §6.4), and nothing else:
 * the audience every access token must carry, and the payment clients.
 *
 * Separate from {@link OAuthConfig} because the session source lives in
 * `AuthModule`, which every process with `McpModule` loads, the scheduler
 * included. `OAUTH_CONFIG` must not exist there: it demands the request cookie
 * secret and `AUTH_SESSION_SOURCE=both`. This reads the same variables through
 * the same parsers, so where both exist they hold the same values.
 */
export interface OAuthSessionConfig {
  /** `MCP_PUBLIC_URL`: the only audience an access token may carry (§6.3.13). */
  readonly audience: string;
  /** Client ids whose grants may bind a payment key and use the API host (§6.3.13). */
  readonly paymentClients: readonly string[];
}

export const OAUTH_SESSION_CONFIG = Symbol('OAUTH_SESSION_CONFIG');

export function loadOAuthSessionConfig(env: NodeJS.ProcessEnv = process.env): OAuthSessionConfig {
  const { mcpPublicUrl } = loadMcpHostConfig(env);
  return Object.freeze({
    audience: mcpPublicUrl,
    paymentClients: parsePaymentClientsEnv(env, mcpPublicUrl),
  });
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim() ?? '';
  if (value === '') return fallback;
  if (!/^[1-9][0-9]{0,8}$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
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

  const seen = new Set<string>();
  return Object.freeze(
    parsed.map((entry: unknown, index) => {
      const { uri, review } = (entry ?? {}) as { uri?: unknown; review?: unknown };
      if (!isNonEmptyString(uri) || typeof review !== 'boolean') {
        throw new Error(`${name}[${index}] must be {uri: string, review: boolean}`);
      }
      const problem = redirectUriProblem(uri);
      if (problem) throw new Error(`${name}[${index}] "${uri}": ${problem}`);
      // A duplicate could list one URI as both under review and cleared.
      if (seen.has(uri)) throw new Error(`${name}[${index}] "${uri}" is listed twice`);
      seen.add(uri);
      return Object.freeze({ uri, review });
    }),
  );
}

/**
 * Why `uri` cannot be an allowlist entry, or `null` (§6.3.9). A positive rule:
 * an exact, canonical `https:` URI, or a private-use scheme (RFC 8252 §7.1: reverse-domain, or one of
 * {@link NAMED_PRIVATE_SCHEMES}) with a path. Everything else is refused. No
 * wildcard, query, fragment or userinfo in any of them.
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

  const { protocol } = parsed;
  if (protocol === 'http:') {
    // Loopback is §6.3.9 rule 1, matched with the port ignored; an exact
    // allowlist entry would pin a port and duplicate that rule.
    return 'http is never an allowlist entry; loopback redirects are allowed by their own rule';
  }
  if (protocol === 'https:') {
    // The match is exact on the string, so it must be the form a browser sends.
    if (parsed.href !== uri) return `not canonical; write it as "${parsed.href}"`;
    return null;
  }
  if (!REVERSE_DOMAIN_SCHEME.test(protocol) && !NAMED_PRIVATE_SCHEMES.has(protocol)) {
    return 'only an exact https URI or a private-use (reverse-domain) scheme is allowed';
  }
  if (!parsed.pathname || parsed.pathname === '/') return 'a private-use redirect needs a path';
  return null;
}

function parseVerifiedClients(
  raw: string | undefined,
  allowlist: readonly OAuthRedirectAllowlistEntry[],
  mcpPublicUrl: string,
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
      // Only a CIMD client proves its domain; a dcr_ id or the built-in client never can.
      if (
        classify(clientId, { mcpPublicUrl, allowHttpLoopback: false }).kind !== 'CIMD' ||
        !clientId.startsWith('https://')
      ) {
        throw new Error(
          `${name}[${index}] clientId "${clientId}" must be an https CIMD client_id URL`,
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

/**
 * Owner decision H2 (§6.3.13): only the built-in `assay-mcp` client's grants
 * may bind a payment key. The variable exists so the list is explicit in a
 * deployment, but it cannot widen that rule: any other id fails the boot.
 */
function parsePaymentClients(raw: string | undefined, builtin: string): readonly string[] {
  if (!raw?.trim()) return Object.freeze([builtin]);
  const name = OAUTH_PAYMENT_CLIENTS_ENV;
  const parsed = parseJson(name, raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isNonEmptyString)) {
    throw new Error(`${name} must be a non-empty JSON array of client id strings`);
  }
  for (const clientId of parsed) {
    if (clientId !== builtin) {
      throw new Error(
        `${name}: "${clientId}" is not the built-in client "${builtin}"; ` +
          'only assay-mcp grants may bind a payment key',
      );
    }
  }
  return Object.freeze([...new Set(parsed)]);
}
