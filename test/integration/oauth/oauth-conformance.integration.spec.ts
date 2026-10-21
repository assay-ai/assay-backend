import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as https from 'node:https';
import { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';

import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppApiModule } from '@bootstrap/api/app.module';
import { AppMcpModule } from '@bootstrap/mcp/app.module';
import { McpExceptionsFilter } from '@bootstrap/mcp/mcp-exceptions.filter';
import { mcpCorsOptions } from '@bootstrap/mcp/mcp-cors';
import { AccountId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import {
  MCP_SESSION_SOURCE,
  McpCallerKind,
  McpSession,
  McpSessionPort,
} from '@modules/mcp/ports/mcp-session.port';
import { CimdFetcher } from '@modules/oauth/services/cimd.fetcher';
import {
  OAUTH_CLEANUP_LOCK_KEY,
  OAuthCleanupService,
} from '@modules/oauth/services/oauth-cleanup.service';
import {
  CONTINUE_EXPIRED_PAGE,
  CONTINUE_WRONG_BROWSER_PAGE,
  RATE_LIMITED_PAGE,
  UNAVAILABLE_PAGE,
} from '@modules/oauth/views/oauth-pages';
import { digestToken } from '@shared/crypto/token-digest';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { LoggingInterceptor } from '@shared/interceptors/logging.interceptor';
import { TransformInterceptor } from '@shared/interceptors/transform.interceptor';
import { EgressConnectOverride, EgressHttpClient, EgressTarget } from '@shared/network/egress';
import { StructuredLogger } from '@shared/observability';

import { freshMigratedDatabase, runDatabaseName } from '../helpers/slash-prorata-context';
import { testConnectionOptions } from '../helpers/test-database';

// `bull-board.module.ts` has a type error ts-jest reports and the build does
// not; the API app imports it, and it has nothing to do with OAuth.
jest.mock('../../../src/bull-board/bull-board.module', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Module } = require('@nestjs/common');
  class BullBoardConfigModule {}
  Module({})(BullBoardConfigModule);
  return { BullBoardConfigModule };
});

/**
 * Spec §12.2 (OAuth protocol and security, Part 1): the conformance and
 * security suite, Task 1.18. One file for the GATE 1 reviewer.
 *
 * Most §12.2 bullets are proven by the suites of Tasks 1.3–1.13 and the
 * follow-ups (R1, F1). The checklist below names, for every bullet, the test
 * that proves it (`file › test name`; files under `test/`). The cases no other
 * suite covers over real HTTP are in this file, marked [here].
 *
 * ```text
 * Metadata
 *   PRM bare and path-inserted   unit/oauth/metadata-controller.spec › "the bare form has resource = {MCP}"
 *                                unit/oauth/metadata.spec › "for path /c/weather has resource === \"{MCP}/c/weather\""
 *                                unit/mcp/mcp-host-routing.spec › "/.well-known/oauth-protected-resource/c/weather reaches the metadata controller, not the catch-all"
 *   AS fields                    unit/oauth/metadata.spec › "equals the spec document field by field"
 *                                unit/oauth/metadata-controller.spec › "has issuer exactly MCP_PUBLIC_URL and the §6.3.2 fields", "openid-configuration 404"
 *   WWW-Authenticate exact       unit/mcp/mcp-http-end-to-end.spec › "no token on /c/weather → 401 with WWW-Authenticate naming the path PRM",
 *                                  "bad token → the same challenge plus error=\"invalid_token\"", "/?tools=… → resource_metadata for / …"
 *                                unit/oauth/www-authenticate.spec (exact header, never offline_access)
 *   CORS exposes it              unit/mcp/mcp-http-end-to-end.spec › "CORS preflight exposes www-authenticate",
 *                                  "the 401 itself exposes www-authenticate to a browser client"
 * PKCE
 *   missing, plain               integration/oauth/oauth-endpoints › "missing code_challenge → redirect error=invalid_request (R-OA-4)",
 *                                  "code_challenge_method=plain → invalid_request"
 *   wrong verifier               integration/oauth/code-exchange › "wrong verifier → invalid_grant AND a correct retry also fails (burned)"
 *   length bounds                unit/oauth/pkce.spec › "refuses 42 characters and accepts 43", "accepts 128 characters and refuses 129"
 *                                [here] "PKCE length bounds over HTTP: …"
 * Codes
 *   60 s                         integration/oauth/code-exchange › "code valid 60 s: at 61 s → invalid_grant", "… at 59 s → a token pair"
 *   burned on step-2 failure     integration/oauth/code-exchange › "wrong verifier → invalid_grant AND a correct retry also fails (burned)"
 *   second exchange revokes      integration/oauth/code-exchange › "second exchange of a used code revokes the first grant and audits oauth.code_reused"
 *   wrong redirect_uri, client   integration/oauth/code-exchange › "wrong redirect_uri → invalid_grant, …", "wrong client_id → invalid_grant, …"
 * Browser binding
 *   continue w/o or other cookie integration/oauth/oauth-endpoints › "continue without cookie → error page; with another browser's cookie → error page (R-OA-8)"
 *                                integration/oauth/oauth-endpoints › "T8: a request an attacker started and a victim approved yields no code to anyone"
 *   approve then continue → code integration/oauth/oauth-endpoints › "approve then continue → 302 with code, state, iss={MCP}; …"
 *   deny → access_denied         integration/oauth/oauth-endpoints › "deny → error=access_denied"
 * Consent
 *   HUMAN only, AGENT refused    integration/oauth/consent-api › "AGENT token → 403 AUTH_HUMAN_SESSION_REQUIRED on read, approve and deny"
 *   first-org binding            integration/oauth/consent-api › "first reader binds; other org → 404 OAUTH_REQUEST_NOT_FOUND"
 *   double approve 409           integration/oauth/consent-api › "approve twice → 409 OAUTH_REQUEST_ALREADY_DECIDED; …",
 *                                  "after continue took the request, the tombstone still answers 409"
 *   expired 404                  integration/oauth/consent-api › "expired (TTL elapsed) → 404"
 *   50 cap, idle-dead not counted integration/oauth/consent-api › "51st live grant → 409 OAUTH_GRANT_LIMIT_REACHED; 49 live + expired + revoked → ok"
 *                                integration/oauth/code-exchange › "refuses the 51st live grant …; an expired grant does not count"
 *   OAUTH_AGENT_NOT_ACTIVE       integration/oauth/consent-api › "suspended agent, suspended org or no wallet → 409 OAUTH_AGENT_NOT_ACTIVE"
 *   replaces of other org etc.   integration/oauth/consent-api › "replaces of another org/client/agent → field absent, and dropped from the approval"
 *                                integration/oauth/code-exchange › "replaces from a client that is not the built-in one is ignored",
 *                                  "replaces naming another agent’s credential is ignored"
 * Refresh
 *   rotation moves expires_at    integration/oauth/refresh › "rotation moves credential expires_at to child expiry"
 *   parallel within 30 s         integration/oauth/refresh › "two refreshes within 30 s → identical pair, …",
 *                                  "parallel refreshes of one token: one child, every caller gets the same pair"
 *   reuse 31 s, used descendant  integration/oauth/refresh › "reuse at 31 s after a child access token was used → grant revoked + notification + …",
 *                                  "reuse at 31 s after the child refresh token was used → grant revoked"
 *   reuse 31 s, none used        integration/oauth/refresh › "reuse at 31 s with no used descendant → invalid_grant, credential live, oauth.refresh_stale_reuse"
 *   Redis flushed within grace   integration/oauth/refresh › "Redis flushed inside grace → invalid_grant, no revoke"
 *   wrong client                 integration/oauth/refresh › "wrong client → invalid_grant"
 *   30-day expiry not live       integration/oauth/refresh › "30-day expiry → credential not live (countLive excludes it)"
 * Resource
 *   other origin invalid_target  integration/oauth/code-exchange › "resource on another origin → invalid_target (and the code is burned)"
 *                                [here] "resource at authorize: another origin is invalid_target; a path or none is accepted"
 *   any path normalises, missing unit/oauth/scope-and-resource.spec › "missing gives {MCP}", "same origin with any path gives {MCP}"
 *                                integration/oauth/code-exchange › "a resource on the MCP origin with a path is accepted"
 * Redirect
 *   each allowlist form          unit/oauth/redirect-uri.spec › "allowlist" and "loopback (RFC 8252 §7.3)" blocks
 *                                [here] "redirect allowlist over HTTP: a cleared vendor callback is honoured, review:true is refused at registration and in a CIMD document"
 *   review:true refused          unit/oauth/redirect-uri.spec › "https://claude.ai/api/mcp/auth_callback is refused while review:true"
 *   port-agnostic loopback       unit/oauth/redirect-uri.spec › "ignores the port on both sides";
 *                                integration/oauth/oauth-endpoints › "register has no CORS headers, and registers a public loopback client (R-OA-10)"
 *   prefix/wildcard/query/frag   unit/oauth/redirect-uri.spec › "refuses prefix, suffix, case, encoding and authority variants", "…redirect?x=1 is refused", "…redirect#f is refused"
 *                                [here] "redirect attacks at authorize: prefix, suffix, query, fragment and wildcard never redirect"
 *   pre-redirect never redirects integration/oauth/oauth-endpoints › "unknown client → 302 to {WEB}/connect/authorize-error?reason=client_unknown, never to redirect_uri",
 *                                  "redirect_uri mismatch → reason=redirect_uri_mismatch (R-OA-7)"
 * "Verified"
 *   listed + vendor callback     unit/oauth/client-registry.spec › "verified only with vendor redirect"; [here] "verified: a listed client returning to its vendor callback"
 *   same id with loopback        unit/oauth/client-registry.spec › "same client with loopback → verified false"; [here] "verified: the same client returning to loopback says it is"
 *   eTLD+1, punycode display     unit/oauth/registrable-domain.spec › "a.b.claude.ai → claude.ai", "an xn-- IDN stays punycode"; [here] "punycode display"
 * DCR
 *   secret methods refused       unit/oauth/dcr.service.spec › "client_secret_post refused", "any client_secret* member refused"; [here] "DCR over HTTP: secret methods refused"
 *   bad redirect                 unit/oauth/dcr.service.spec › "bad redirect refused";
 *                                [here] "redirect allowlist over HTTP: …" (DCR → 400 invalid_redirect_uri for each review:true entry)
 *   /64 rate key                 unit/oauth/dcr.service.spec › "21st per /64 in an hour refused"; [here] "DCR over HTTP: /64 rate key"
 *   no CORS                      integration/oauth/oauth-endpoints › "register has no CORS headers, and registers a public loopback client (R-OA-10)"
 *   prune respects FK            integration/oauth/oauth-cleanup › "referenced DCR client survives", "a soft-deleted grant still holds its client"
 *                                [here] "prune respects FK"
 * CIMD SSRF
 *   127.0.0.1, ::1, 169.254.169.254, 10/8, IPv4-mapped IPv6
 *                                integration/oauth/cimd-ssrf › "%s → blocked_address, never dialled" (it.each); [here] "IPv4-mapped IPv6 CIMD blocked"
 *   DNS rebinding                integration/oauth/cimd-ssrf › "DNS rebinding: one lookup per fetch, …"
 *   302 to internal              integration/oauth/cimd-ssrf › "302 to an internal address → refused; …"
 *   > 16 KB                      integration/oauth/cimd-ssrf › "more than 16 KB → too_large", "a chunked body over 16 KB with no Content-Length → too_large on arrival"
 *   slow drip                    integration/oauth/cimd-ssrf › "a slow drip past 5 s → timeout, within the 5 s budget"
 *   non-JSON, client_id mismatch unit/oauth/cimd-fetcher.spec › "non-JSON → invalid", "client_id byte mismatch → client_metadata_invalid"
 *   port 8443                    unit/oauth/client-id.spec › "https://x.com:8443/c → UNKNOWN"; [here] "port 8443 refused"
 *   IP literal                   integration/oauth/cimd-ssrf › "an IP-literal client_id is refused before any lookup or socket"; [here] "IP literal refused"
 *   cache bounds                 unit/oauth/cimd-fetcher.spec › "max-age 10 clamps to 300", "max-age 999999 clamps to 86400", "failure cached 60 s"
 *   per-IP budget                unit/oauth/cimd-fetcher.spec › "per-IP budget 11th in a minute → budget"
 *   verified pre-warm            unit/oauth/client-registry.spec › "pre-warms the verified clients’ CIMD documents",
 *                                  "pre-warms only on the MCP app: …"; unit/oauth/cimd-fetcher.spec › "verified client exempt";
 *                                [here] "verified pre-warm at boot"
 * Logs
 *   log and body capture         integration/oauth/oauth-log-canary › "F1 → F2 → refusals → revoke leaves no secret in any log line or error body"
 *                                [here] this whole suite runs under the real StructuredLogger and LoggingInterceptor with every
 *                                  process write captured: "logs: authorize, consent, continue, token, refresh and revoke, …" drives
 *                                  the secret-bearing flows and their error paths, and "logs: nothing the suite captured holds …"
 *                                  scans every line and error body of every test in this file
 *   APM                          No APM agent is installed (no dd-trace, elastic-apm-node, newrelic, @opentelemetry or @sentry
 *                                  in package.json or src; asserted [here]). There are no spans to scrub; log and error-body
 *                                  capture is the whole surface.
 * Revocation endpoint
 *   refresh → grant revoked      integration/oauth/refresh › "revoke refresh → credential revoked_at set; revoke unknown → no error"
 *                                integration/oauth/oauth-endpoints › "token response has Cache-Control no-store; refresh rotates; revoke is 200 empty; …"
 *   access → itself              integration/oauth/refresh › "revoke access token → only that token is revoked"
 *   unknown → 200                unit/oauth/oauth-endpoints.controller.spec › "always 200 with an empty body"
 * Frame
 *   iframe refused               frontend src/config/security-headers.test.ts › "_headers /connect/* has frame-ancestors 'none', X-Frame-Options DENY, Referrer-Policy no-referrer",
 *                                  "next dev refuses framing and the referrer on those pages too" (Task 1.16);
 *                                the real-browser iframe load of the built `out/` consent page is a GATE 1 browser item (R-WEB-4)
 *   buttons disabled when framed frontend src/components/oauth/consent-card.dom.test.tsx › "buttons disabled when window.top !== window.self"
 *                                [here] "the pages the MCP host serves itself carry no referrer, no script and no link"
 * ```
 *
 * §11 rows tagged Part 1 (GATE 1 item 2): a test per row, or OPEN with the task that closes it.
 *
 * ```text
 * T1  no signing key; hashed     integration/oauth/code-exchange › "no raw secret in any column, and no hash outside the hash columns …";
 *                                integration/oauth/refresh › "no raw token in any column, and no hash outside the hash columns"
 * T3  1 h, revocable, MCP host   integration/oauth/code-exchange › "mints assay_ac_ codes …"; integration/oauth/oauth-endpoints ›
 *                                  "approve then continue → 302 with code, …" (expires_in 3600); integration/oauth/oauth-session-source ›
 *                                  "revoking the credential refuses the very next request (R-OA-19)",
 *                                  "third-party grant: the MCP host gets paymentsAllowed false, the API host 403"
 * T4  refresh theft              integration/oauth/refresh › "wrong client → invalid_grant", "reuse at 31 s after a child access token
 *                                  was used → grant revoked + …", "reuse at 31 s after the child refresh token was used → grant revoked",
 *                                  "30-day expiry → credential not live (countLive excludes it)", "revoke refresh → credential revoked_at set; …"
 * T5  malicious approved app     "Verified" bullets above; integration/account/agent-delegate-binding › "third-party OAuth session →
 *                                  challenge and bind refused ACCOUNT_DELEGATE_CLIENT_NOT_ALLOWED"; integration/oauth/oauth-session-source ›
 *                                  "third-party grant: the MCP host gets paymentsAllowed false, the API host 403" (API host refused).
 *                                OPEN: "PAYMENT_REQUIRED without fixUrl for a non-payment client" has no test yet; it is an it.todo in
 *                                  the 1.17 equivalence suite, deferred to Task 2.13. The enable-paid page refusal is Part 2.
 * T6  open redirect              Redirect bullets above (pre-redirect errors never redirect; review:true refused; attacks [here])
 * T7  CIMD SSRF                  CIMD SSRF bullets above; unit/oauth/cimd-fetcher.spec › "per-host budget: the 31st fetch to one host
 *                                  in a minute → budget", "global budget: the 601st fetch in a minute → budget"
 * T8  consent phishing           Browser-binding and consent bullets above (T8 attack test, first-reader binding); rid redaction in the
 *                                  log canary and [here] logs tests; frame bullets above (real-browser iframe load: GATE 1 item 6)
 * T9  replay                     Code bullets above; unit/account/agent-delegate.service.spec › "consumes a challenge on its first use"
 *                                  (binding challenge GETDEL)
 * T14 cross-process race         integration/oauth/refresh › "two refreshes within 30 s → identical pair, …", "parallel refreshes of one
 *                                  token: …", "reuse at 31 s with no used descendant → invalid_grant, credential live, …",
 *                                  "Redis flushed inside grace → invalid_grant, no revoke"
 * T15 audience confusion         integration/oauth/oauth-session-source › "a token issued for another audience is refused (T15)",
 *                                  "third-party grant: the MCP host gets paymentsAllowed false, the API host 403"
 * T16 suspension                 unit/auth/oauth-access-token-mcp-session.source.spec › "a suspended agent is refused as suspended, not as
 *                                  invalid (T16)"; integration/oauth/refresh › "suspended agent: refresh succeeds"
 * R-OA-23 revoke cascade         integration/oauth/revoke-cascade (whole file)
 * ```
 *
 * The §12.1 equivalence suite is Task 1.17 (`integration/oauth/equivalence*`, on its own branch).
 *
 * What runs here: the real `AppMcpModule` and `AppApiModule` over HTTP,
 * against a migrated test database and a real Redis, as the endpoints suite
 * does. `EgressHttpClient` is the real class with only its resolver and its
 * socket destination replaced (as in the CIMD SSRF suite): every name gets a
 * scripted DNS answer, and sockets to public answers land on a local HTTPS
 * server with a certificate made for this run.
 *
 * Every other socket is fenced too: `net.Socket.prototype.connect` is wrapped
 * for the suite so that any TCP connection to a host other than this machine
 * (the test database and Redis included only by their configured host) is
 * refused and recorded, and the last test asserts none was attempted. The
 * process-wide egress lockdown cannot be used here: it is irreversible and
 * would also block supertest in the files that run after this one.
 */

const PUBLIC_ADDRESS = '93.184.216.34';

/** Host → its DNS answer. Anything else is ENOTFOUND. */
const answers: Record<string, Array<{ address: string; family: 4 | 6 }>> = {
  'vendor.example.com': [{ address: PUBLIC_ADDRESS, family: 4 }],
  'chat-client.example.com': [{ address: PUBLIC_ADDRESS, family: 4 }],
  'review-client.example.com': [{ address: PUBLIC_ADDRESS, family: 4 }],
  'tools.example.com': [{ address: PUBLIC_ADDRESS, family: 4 }],
  'xn--exmple-cua.com': [{ address: PUBLIC_ADDRESS, family: 4 }],
  'mapped.example.com': [{ address: '::ffff:127.0.0.1', family: 6 }],
  'mapped-metadata.example.com': [{ address: '::ffff:169.254.169.254', family: 6 }],
  'mapped-private.example.com': [{ address: '::ffff:10.0.0.1', family: 6 }],
};

const lookup = jest.fn(async (hostname: string) => {
  const answer = answers[hostname];
  if (answer) return answer;
  const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  error.code = 'ENOTFOUND';
  throw error;
});

/** Every address a socket was opened for, as the egress guard approved it. */
const dialled: string[] = [];
/** `host path` of every request the local document server answered. */
const hits: string[] = [];
let serverPort = 0;

const connectOverride: EgressConnectOverride = (target: EgressTarget) => {
  dialled.push(target.address);
  return { address: '127.0.0.1', family: 4, port: serverPort };
};

/** Destinations off this machine that any socket in the process tried to reach. */
const blockedConnections: string[] = [];
const originalConnect = Socket.prototype.connect;

/** Refuse (and record) every TCP connection to a host not in `allowed` or loopback. */
function installNetworkFence(allowed: readonly string[]): void {
  const hosts = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1', ...allowed]);
  const connect = originalConnect as unknown as (this: Socket, ...args: unknown[]) => Socket;
  Socket.prototype.connect = function fenced(this: Socket, ...args: unknown[]): Socket {
    // `net.connect` passes its normalised [options, callback] as one array.
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    let host: string;
    let port: unknown;
    if (typeof first === 'object' && first !== null) {
      const options = first as {
        host?: string;
        port?: unknown;
        path?: string;
        lookup?: (...a: unknown[]) => void;
      };
      if (options.path) return connect.apply(this, args); // a local socket file
      host = options.host ?? 'localhost';
      port = options.port;
      const resolve = options.lookup;
      if (!hosts.has(host) && typeof resolve === 'function') {
        // A pinned resolver (the egress client's): judge the address it
        // answers, which is where the socket really goes.
        const name = host;
        options.lookup = (hostname: unknown, opts: unknown, callback: unknown) =>
          resolve(hostname, opts, (error: unknown, address: unknown, family: unknown) => {
            const answers = Array.isArray(address)
              ? (address as Array<{ address: string }>).map((entry) => entry.address)
              : [String(address)];
            const off = answers.filter((answer) => !hosts.has(answer));
            if (!error && off.length > 0) {
              blockedConnections.push(`${name}->${off.join(',')}:${String(port)}`);
              (callback as (e: Error) => void)(
                new Error('conformance suite: off-machine socket refused'),
              );
              return;
            }
            (callback as (e: unknown, a: unknown, f: unknown) => void)(error, address, family);
          });
        return connect.apply(this, args);
      }
    } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      port = first;
      host = typeof args[1] === 'string' ? args[1] : 'localhost';
    } else {
      return connect.apply(this, args); // a local socket path
    }
    if (hosts.has(host)) return connect.apply(this, args);
    blockedConnections.push(`${host}:${String(port)}`);
    process.nextTick(() =>
      this.destroy(new Error('conformance suite: off-machine socket refused')),
    );
    return this;
  } as typeof Socket.prototype.connect;
}

/** Everything the process writes while the suite runs: logs, warnings, error stacks. */
const captured: string[] = [];

function captureOutput(): () => void {
  const capture = (chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  };
  const spies = [
    jest.spyOn(process.stdout, 'write').mockImplementation(capture),
    jest.spyOn(process.stderr, 'write').mockImplementation(capture),
    jest.spyOn(console, 'log').mockImplementation((...a) => capture(a.join(' '))),
    jest.spyOn(console, 'info').mockImplementation((...a) => capture(a.join(' '))),
    jest.spyOn(console, 'warn').mockImplementation((...a) => capture(a.join(' '))),
    jest.spyOn(console, 'error').mockImplementation((...a) => capture(a.join(' '))),
    jest.spyOn(console, 'debug').mockImplementation((...a) => capture(a.join(' '))),
  ];
  return () => spies.forEach((spy) => spy.mockRestore());
}

describe('OAuth §12.2 conformance and security (Task 1.18) — AppMcpModule and AppApiModule, real database and Redis', () => {
  const DATABASE = 'assay_oauth_conformance_test';
  const MCP = 'https://mcp.example.test';
  const WEB = 'https://app.example.test';
  const BUILTIN = `${MCP}/oauth/clients/assay-mcp`;
  const LOOPBACK = 'http://127.0.0.1/callback';
  const CHAIN = CHAIN_IDS.SOLANA_DEVNET as ChainId;
  const WALLETS = [
    '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
  ];
  const HUMAN = `conformance-human-${randomBytes(12).toString('hex')}`;
  const STATE = `st-${randomBytes(12).toString('hex')}`;

  const VENDOR = 'https://vendor.example.com/oauth/client.json';
  const VENDOR_CALLBACK = 'https://vendor.example.com/oauth/callback';
  const CHATGPT_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const CHAT_CLIENT = 'https://chat-client.example.com/client.json';
  const REVIEW_CLIENT = 'https://review-client.example.com/client.json';
  const PUNY_CLIENT = 'https://xn--exmple-cua.com/oauth/client.json';
  const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

  const ORG = randomUUID();
  const PERSON = randomUUID();
  const AGENT = randomUUID();

  const ENV: Record<string, string> = {
    NODE_ENV: 'local',
    TYPEORM_CACHE_TTL_MULTIPLIER: '1',
    TYPEORM_CACHE_ENABLED: 'false',
    SERVICE_TYPE: 'all',
    MCP_PUBLIC_URL: MCP,
    WEB_APP_URL: WEB,
    AUTH_SESSION_SOURCE: 'both',
    PRIVY_APP_ID: 'conformance-test-app',
    PRIVY_DEFAULT_CHAIN_ID: CHAIN,
    PRIVY_USER_LOOKUP_ENABLED: 'false',
    ENABLED_CHAINS: CHAIN,
    BULLBOARD_ENABLED: 'false',
    BULLBOARD_USERNAME: 'conformance-test',
    BULLBOARD_PASSWORD: 'conformance-test-password',
    JWT_SECRET: 'conformance-test-jwt-'.repeat(3),
    MCP_SEARCH_CURSOR_SECRET: 'conformance-test-'.repeat(3),
    // The §6.3.9 defaults, plus one vendor callback cleared for this suite.
    OAUTH_REDIRECT_ALLOWLIST: JSON.stringify([
      { uri: CHATGPT_CALLBACK, review: false },
      { uri: VENDOR_CALLBACK, review: false },
      { uri: CLAUDE_CALLBACK, review: true },
      { uri: 'https://claude.com/api/mcp/auth_callback', review: true },
      { uri: 'https://vscode.dev/redirect', review: true },
      { uri: 'cursor://anysphere.cursor-mcp/oauth/callback', review: true },
    ]),
    OAUTH_VERIFIED_CLIENTS: JSON.stringify([
      { clientId: VENDOR, displayName: 'Vendor Tool', vendorRedirects: [VENDOR_CALLBACK] },
    ]),
    // The shared Redis keeps the daily DCR count across runs of the suites.
    OAUTH_DCR_GLOBAL_PER_DAY: '1000000',
  };

  let saved: NodeJS.ProcessEnv;
  let dataSource: DataSource;
  let redis: Redis;
  let mcp: INestApplication;
  let api: INestApplication;
  let certDir: string;
  let defaultCAs: string[];
  let server: https.Server;
  const sockets = new Set<Socket>();
  /** Lookups of the verified client's host made while only the API app was up. */
  let vendorLookupsAfterApiBoot = -1;
  /** The API app's own CimdFetcher: the API app must never fetch a client document. */
  let apiCimdFetch: jest.SpyInstance;
  let restoreOutput: () => void = () => undefined;

  /** Every secret the suite makes or receives; none may reach a log line or an error body. */
  const secrets = new Set<string>([HUMAN, STATE]);
  const keep = (...values: Array<string | null | undefined>) => {
    for (const value of values) if (value) secrets.add(value);
  };
  /** Error bodies the suite received. */
  const bodies: string[] = [];
  const keepBody = <T extends { status: number; text: string }>(response: T): T => {
    if (response.status >= 400) bodies.push(response.text ?? '');
    return response;
  };

  const humanSession = {
    credentialId: 'user-conformance',
    organizationId: ORG,
    agentId: PERSON,
    agentAccount: `${CHAIN}:${WALLETS[0]}` as AccountId,
    chainId: CHAIN,
    label: null,
    callerKind: McpCallerKind.HUMAN,
    paymentsAllowed: true,
  } as McpSession;

  const humanSource: McpSessionPort = {
    resolve: async (token: string | null) => {
      if (token !== HUMAN) throw McpErrors.credentialInvalid();
      return humanSession;
    },
  } as McpSessionPort;

  /** The test egress client: the real class, scripted DNS, sockets to the local server. */
  const egress = () => new EgressHttpClient(lookup, connectOverride, null);

  function clientDocument(url: string): Record<string, unknown> | null {
    switch (url) {
      case VENDOR:
        return {
          client_id: url,
          client_name: 'Vendor Tool CLI',
          redirect_uris: [VENDOR_CALLBACK, LOOPBACK],
          token_endpoint_auth_method: 'none',
        };
      case CHAT_CLIENT:
        return {
          client_id: url,
          client_name: 'Chat Client',
          redirect_uris: [CHATGPT_CALLBACK],
          token_endpoint_auth_method: 'none',
        };
      case REVIEW_CLIENT:
        // Lists a callback still under review: the whole document is refused.
        return {
          client_id: url,
          client_name: 'Review Client',
          redirect_uris: [CLAUDE_CALLBACK, LOOPBACK],
          token_endpoint_auth_method: 'none',
        };
      case PUNY_CLIENT:
        return {
          client_id: url,
          client_name: 'Example Tools',
          redirect_uris: [LOOPBACK],
          token_endpoint_auth_method: 'none',
        };
      default:
        return null;
    }
  }

  function handle(req: IncomingMessage, res: ServerResponse) {
    const host = String(req.headers.host);
    hits.push(`${host} ${req.url}`);
    const document = clientDocument(`https://${host}${req.url}`);
    if (!document) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(document));
  }

  /** A throwaway self-signed CA certificate for the suite's hosts, made with openssl. */
  function makeCertificate(): { cert: string; key: string } {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(certDir, 'key.pem'),
        '-out',
        join(certDir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=example.com',
        '-addext',
        'subjectAltName=DNS:*.example.com,DNS:xn--exmple-cua.com',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
      ],
      { stdio: 'ignore' },
    );
    return {
      cert: readFileSync(join(certDir, 'cert.pem'), 'utf8'),
      key: readFileSync(join(certDir, 'key.pem'), 'utf8'),
    };
  }

  const vendorLookups = () =>
    lookup.mock.calls.filter(([host]) => host === 'vendor.example.com').length;

  beforeAll(async () => {
    saved = { ...process.env };
    installNetworkFence([
      testConnectionOptions().host ?? 'localhost',
      process.env.REDIS_HOST || 'localhost',
    ]);
    restoreOutput = captureOutput();

    certDir = mkdtempSync(join(tmpdir(), 'oauth-conformance-'));
    const { cert, key } = makeCertificate();
    defaultCAs = tls.getCACertificates('default');
    tls.setDefaultCACertificates([...defaultCAs, cert]);
    server = https.createServer({ cert, key }, handle);
    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverPort = (server.address() as AddressInfo).port;

    dataSource = await freshMigratedDatabase(DATABASE);
    const connection = testConnectionOptions();
    Object.assign(process.env, ENV, {
      DATABASE_HOST: connection.host,
      DATABASE_PORT: String(connection.port),
      DATABASE_USER: connection.username,
      DATABASE_PASSWORD: connection.password,
      DATABASE_NAME: runDatabaseName(DATABASE),
      OAUTH_REQUEST_COOKIE_SECRET: randomBytes(32).toString('hex'),
      REDIS_HOST: process.env.REDIS_HOST || 'localhost',
      REDIS_PORT: process.env.REDIS_PORT || '6379',
      REDIS_URL: `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`,
    });

    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
    });
    // A failed CIMD fetch is remembered for 60 s in the shared Redis: a rerun
    // within that minute must still reach the resolver.
    const remembered = await redis.keys('oauth:cimd:fail:*');
    if (remembered.length > 0) await redis.del(...remembered);

    await dataSource.query(
      `INSERT INTO "organizations" ("id", "name", "status") VALUES ($1, 'Conformance org', 'ACTIVE')`,
      [ORG],
    );
    for (const [index, id] of [PERSON, AGENT].entries()) {
      await dataSource.query(
        `INSERT INTO "agents"
           ("id", "organization_id", "privy_user_id", "status", "primary_account_id", "chain_id", "label")
         VALUES ($1, $2, $3, 'ACTIVE', $4, $5, 'conformance-bot')`,
        [id, ORG, `did:privy:test-${id}`, `${CHAIN}:${WALLETS[index]}`, CHAIN],
      );
    }

    // The API app first, alone: it must make no outbound call at boot.
    const apiRef = await Test.createTestingModule({ imports: [AppApiModule] })
      .overrideProvider(MCP_SESSION_SOURCE)
      .useValue(humanSource)
      .overrideProvider(EgressHttpClient)
      .useValue(egress())
      .compile();
    apiCimdFetch = jest.spyOn(apiRef.get(CimdFetcher, { strict: false }), 'fetch');
    api = apiRef.createNestApplication({ logger: new StructuredLogger() });
    api.setGlobalPrefix('api');
    api.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    api.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    api.useGlobalFilters(new AllExceptionsFilter());
    api.useGlobalInterceptors(new LoggingInterceptor(), new TransformInterceptor());
    // Bound once, on 127.0.0.1 exactly: supertest then reuses this address
    // instead of an ephemeral wildcard listen per request, which another local
    // process holding the same port on 127.0.0.1 could answer.
    await api.listen(0, '127.0.0.1');
    vendorLookupsAfterApiBoot = vendorLookups();

    const mcpRef = await Test.createTestingModule({ imports: [AppMcpModule] })
      .overrideProvider(EgressHttpClient)
      .useValue(egress())
      .compile();
    const mcpApp = mcpRef.createNestApplication<NestExpressApplication>({
      logger: new StructuredLogger(),
    });
    mcpApp.set('trust proxy', 1);
    mcpApp.enableCors(mcpCorsOptions);
    mcpApp.useGlobalFilters(new McpExceptionsFilter());
    mcpApp.useGlobalInterceptors(new LoggingInterceptor());
    await mcpApp.listen(0, '127.0.0.1');
    mcp = mcpApp;
  }, 300_000);

  afterAll(async () => {
    restoreOutput();
    for (const app of [api, mcp]) {
      if (!app) continue;
      const appData = app.get<DataSource>(getDataSourceToken('postgres'), { strict: false });
      const clients = new Set<Redis>();
      for (const module of app.get(ModulesContainer).values()) {
        for (const wrapper of module.providers.values()) {
          if (wrapper.instance instanceof Redis) clients.add(wrapper.instance);
        }
      }
      await app.close().catch(() => undefined);
      await appData?.destroy().catch(() => undefined);
      for (const client of clients) client.disconnect();
    }
    await redis?.del(OAUTH_CLEANUP_LOCK_KEY).catch(() => undefined);
    redis?.disconnect();
    await dataSource?.destroy();
    if (defaultCAs) tls.setDefaultCACertificates(defaultCAs);
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (certDir) rmSync(certDir, { recursive: true, force: true });
    Socket.prototype.connect = originalConnect;
    process.env = saved;
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  function newIp(): string {
    return `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${(randomBytes(1)[0] % 250) + 1}`;
  }

  function pkce(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    keep(verifier, challenge);
    return { verifier, challenge };
  }

  function authorize(params: Record<string, string | undefined>, ip = newIp()): request.Test {
    const defined = Object.entries(params).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );
    return request(mcp.getHttpServer())
      .get(`/oauth/authorize?${new URLSearchParams(defined)}`)
      .set('X-Forwarded-For', ip);
  }

  function baseParams(challenge: string, over: Record<string, string | undefined> = {}) {
    return {
      response_type: 'code',
      client_id: BUILTIN,
      redirect_uri: 'http://127.0.0.1:61234/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: STATE,
      ...over,
    };
  }

  const errorPage = (reason: string) => `${WEB}/connect/authorize-error?reason=${reason}`;

  /** Authorize, then return the rid (from the fragment) and the cookie pair. */
  async function start(challenge: string, over: Record<string, string | undefined> = {}) {
    const response = await authorize(baseParams(challenge, over));
    expect(response.status).toBe(302);
    const rid = /#request=([A-Za-z0-9_-]{43})$/.exec(response.headers.location)![1];
    const setCookie = (response.headers['set-cookie'] as unknown as string[])[0];
    const cookie = setCookie.split(';')[0];
    keep(rid, cookie.slice(cookie.indexOf('=') + 1));
    return { rid, cookie };
  }

  const auth = { Authorization: `Bearer ${HUMAN}` };

  const readRequest = (rid: string) =>
    request(api.getHttpServer()).get(`/api/v1/oauth/requests/${rid}`).set(auth);

  /** A code for the built-in client, through authorize → consent → continue. */
  async function code(challenge: string): Promise<string> {
    const { rid, cookie } = await start(challenge);
    expect((await readRequest(rid)).status).toBe(200);
    const approved = await request(api.getHttpServer())
      .post(`/api/v1/oauth/requests/${rid}/approve`)
      .set(auth)
      .send({ agentId: AGENT, name: 'Conformance test' });
    expect(approved.status).toBe(200);
    const resumed = await request(mcp.getHttpServer())
      .get(`/oauth/authorize/continue?request=${encodeURIComponent(rid)}`)
      .set('Cookie', cookie);
    expect(resumed.status).toBe(302);
    const issued = new URL(resumed.headers.location).searchParams.get('code')!;
    keep(issued);
    return issued;
  }

  const resume = (rid: string, cookie?: string) => {
    const call = request(mcp.getHttpServer()).get(
      `/oauth/authorize/continue?request=${encodeURIComponent(rid)}`,
    );
    return cookie ? call.set('Cookie', cookie) : call;
  };

  async function token(form: Record<string, string>, ip = newIp()) {
    const response = await request(mcp.getHttpServer())
      .post('/oauth/token')
      .set('X-Forwarded-For', ip)
      .type('form')
      .send(form);
    keep(response.body?.access_token, response.body?.refresh_token);
    return keepBody(response);
  }

  const register = (body: Record<string, unknown>, ip = newIp()) =>
    request(mcp.getHttpServer()).post('/oauth/register').set('X-Forwarded-For', ip).send(body);

  async function clientRow(clientId: string) {
    const rows = (await dataSource.query(
      `SELECT "kind", "fetched_at" FROM "oauth_clients" WHERE "client_id" = $1`,
      [clientId],
    )) as { kind: string; fetched_at: Date | null }[];
    return rows[0] ?? null;
  }

  // ── CIMD SSRF over the real authorize endpoint (T7) ──────────────────────

  // ── invalid_client (RFC 6749 §5.2) ─────────────────────────────────────────

  it('token with an unknown client_id → 400 invalid_client, for both grant types', async () => {
    for (const form of [
      {
        grant_type: 'authorization_code',
        code: `assay_ac_${'A'.repeat(43)}`,
        redirect_uri: 'http://127.0.0.1:5000/cb',
        client_id: 'dcr_AAAAAAAAAAAAAAAAAAAAAA',
        code_verifier: 'v'.repeat(43),
      },
      {
        grant_type: 'refresh_token',
        refresh_token: `assay_rt_${'A'.repeat(43)}`,
        client_id: 'https://unknown.example.test/client.json',
      },
    ]) {
      const response = await token(form);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_client' });
    }
  });

  it('verified pre-warm at boot', async () => {
    // The API app booted alone first and looked nothing up.
    expect(vendorLookupsAfterApiBoot).toBe(0);
    expect(apiCimdFetch).not.toHaveBeenCalled();
    // The MCP app fetched the verified client's document at boot, unasked.
    const deadline = Date.now() + 10_000;
    while (!(await clientRow(VENDOR)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const row = await clientRow(VENDOR);
    expect(row).toEqual({ kind: 'CIMD', fetched_at: expect.any(Date) });
    expect(hits).toContain('vendor.example.com /oauth/client.json');

    // Its first authorization is served from the warm cache: no fetch.
    const fetchesBefore = hits.filter((hit) => hit.startsWith('vendor.example.com')).length;
    const response = await authorize(
      baseParams(pkce().challenge, { client_id: VENDOR, redirect_uri: VENDOR_CALLBACK }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.location.startsWith(`${WEB}/connect/authorize#request=`)).toBe(true);
    expect(hits.filter((hit) => hit.startsWith('vendor.example.com')).length).toBe(fetchesBefore);
  });

  it('IPv4-mapped IPv6 CIMD blocked', async () => {
    for (const host of [
      'mapped.example.com',
      'mapped-metadata.example.com',
      'mapped-private.example.com',
    ]) {
      const clientId = `https://${host}/client.json`;
      dialled.length = 0;
      lookup.mockClear();
      const response = await authorize(
        baseParams(pkce().challenge, { client_id: clientId, redirect_uri: LOOPBACK }),
      );
      expect({ host, location: response.headers.location }).toEqual({
        host,
        location: errorPage('client_metadata_invalid'),
      });
      // Resolved, judged by the address it resolved to, and never dialled.
      expect(lookup).toHaveBeenCalledWith(host);
      expect(dialled).toEqual([]);
      expect(await clientRow(clientId)).toBeNull();
    }

    // Spelled as a literal, it is not even a CIMD client id: no lookup at all.
    lookup.mockClear();
    for (const literal of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:a9fe:a9fe]']) {
      const response = await authorize(
        baseParams(pkce().challenge, {
          client_id: `https://${literal}/client.json`,
          redirect_uri: LOOPBACK,
        }),
      );
      expect(response.headers.location).toBe(errorPage('client_unknown'));
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(dialled).toEqual([]);
  });

  it('port 8443 refused', async () => {
    lookup.mockClear();
    dialled.length = 0;
    for (const clientId of [
      'https://vendor.example.com:8443/oauth/client.json',
      'https://tools.example.com:8443/client.json',
    ]) {
      const response = await authorize(
        baseParams(pkce().challenge, { client_id: clientId, redirect_uri: LOOPBACK }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(errorPage('client_unknown'));
      expect(await clientRow(clientId)).toBeNull();
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(dialled).toEqual([]);
  });

  it('IP literal refused', async () => {
    lookup.mockClear();
    dialled.length = 0;
    for (const clientId of [
      `https://${PUBLIC_ADDRESS}/client.json`,
      'https://127.0.0.1/client.json',
      'https://169.254.169.254/latest/meta-data/',
      'https://[2001:db8::1]/client.json',
      'https://[::1]/client.json',
      'https://2130706433/client.json',
      'https://0x7f000001/client.json',
    ]) {
      const response = await authorize(
        baseParams(pkce().challenge, { client_id: clientId, redirect_uri: LOOPBACK }),
      );
      expect({ clientId, location: response.headers.location }).toEqual({
        clientId,
        location: errorPage('client_unknown'),
      });
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(dialled).toEqual([]);
  });

  // ── "Verified" and its display (§6.3.6, R-OA-25) ────────────────────────────

  it('verified: a listed client returning to its vendor callback', async () => {
    const { rid } = await start(pkce().challenge, {
      client_id: VENDOR,
      redirect_uri: VENDOR_CALLBACK,
    });
    const read = await readRequest(rid);
    expect(read.status).toBe(200);
    expect(read.body.data.client).toEqual({
      name: 'Vendor Tool',
      kind: 'CIMD',
      registrableDomain: 'example.com',
      host: 'vendor.example.com',
      verified: true,
      builtin: false,
      paymentClient: false,
    });
    expect(read.body.data.returnTo).toEqual({ kind: 'WEB', display: 'vendor.example.com' });
  });

  it('verified: the same client returning to loopback says it is', async () => {
    const { rid } = await start(pkce().challenge, {
      client_id: VENDOR,
      redirect_uri: 'http://127.0.0.1:43123/callback',
    });
    const read = await readRequest(rid);
    expect(read.status).toBe(200);
    // Its own (self-declared) name, not the vetted display name.
    expect(read.body.data.client).toEqual(
      expect.objectContaining({ name: 'Vendor Tool CLI', verified: false, builtin: false }),
    );
    expect(read.body.data.returnTo).toEqual({
      kind: 'LOCAL_APP',
      display: 'an app on this computer',
    });
  });

  it('punycode display', async () => {
    const { rid } = await start(pkce().challenge, {
      client_id: PUNY_CLIENT,
      redirect_uri: LOOPBACK,
    });
    const read = await readRequest(rid);
    expect(read.status).toBe(200);
    // The IDN is shown as punycode, never decoded into look-alike Unicode.
    expect(read.body.data.client).toEqual(
      expect.objectContaining({
        kind: 'CIMD',
        host: 'xn--exmple-cua.com',
        registrableDomain: 'xn--exmple-cua.com',
        verified: false,
      }),
    );

    // The Unicode spelling of the same host is not a client id: a fetch would
    // rewrite it, so it could never byte-match its document.
    lookup.mockClear();
    const unicode = await authorize(
      baseParams(pkce().challenge, {
        client_id: 'https://exämple.com/oauth/client.json',
        redirect_uri: LOOPBACK,
      }),
    );
    expect(unicode.headers.location).toBe(errorPage('client_unknown'));
    expect(lookup).not.toHaveBeenCalled();
  });

  // ── redirect URIs (§6.3.9, T6) ───────────────────────────────────────────────

  it('redirect allowlist over HTTP: a cleared vendor callback is honoured, review:true is refused at registration and in a CIMD document', async () => {
    // A CIMD client registering ChatGPT's cleared callback may use it.
    const { rid } = await start(pkce().challenge, {
      client_id: CHAT_CLIENT,
      redirect_uri: CHATGPT_CALLBACK,
    });
    expect((await readRequest(rid)).body.data.returnTo).toEqual({
      kind: 'WEB',
      display: 'chatgpt.com',
    });

    // A document listing a callback still under review is refused whole,
    // before anything goes to any redirect URI.
    for (const redirect of [CLAUDE_CALLBACK, LOOPBACK]) {
      const response = await authorize(
        baseParams(pkce().challenge, { client_id: REVIEW_CLIENT, redirect_uri: redirect }),
      );
      expect(response.headers.location).toBe(errorPage('client_metadata_invalid'));
    }
    expect(await clientRow(REVIEW_CLIENT)).toBeNull();

    // DCR cannot register any review:true entry.
    for (const uri of [
      CLAUDE_CALLBACK,
      'https://claude.com/api/mcp/auth_callback',
      'https://vscode.dev/redirect',
      'cursor://anysphere.cursor-mcp/oauth/callback',
    ]) {
      const response = await register({ client_name: 'Review Probe', redirect_uris: [uri] });
      expect({ uri, status: response.status, body: response.body }).toEqual({
        uri,
        status: 400,
        body: { error: 'invalid_redirect_uri' },
      });
    }
  });

  it('redirect attacks at authorize: prefix, suffix, query, fragment and wildcard never redirect', async () => {
    for (const redirect of [
      `${VENDOR_CALLBACK}/x`,
      `${VENDOR_CALLBACK}x`,
      `${VENDOR_CALLBACK}?next=https://evil.example`,
      `${VENDOR_CALLBACK}#f`,
      'https://vendor.example.com/oauth/',
      'https://vendor.example.com.evil.example/oauth/callback',
      'https://evil.example/oauth/callback',
      'https://VENDOR.example.com/oauth/callback',
      'https://vendor.example.com:443/oauth/callback',
      'https://user@vendor.example.com/oauth/callback',
      'http://127.0.0.1:61234/callback?x=1',
      'http://127.0.0.1:61234/callback#f',
      'http://127.0.0.1:61234/callback/x',
      'http://127.0.0.1.evil.example/callback',
      'https://*.example.com/oauth/callback',
    ]) {
      const response = await authorize(
        baseParams(pkce().challenge, { client_id: VENDOR, redirect_uri: redirect }),
      );
      expect({ redirect, status: response.status, location: response.headers.location }).toEqual({
        redirect,
        status: 302,
        location: errorPage('redirect_uri_mismatch'),
      });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  // ── PKCE and resource over HTTP ─────────────────────────────────────────────

  it('PKCE length bounds over HTTP: a 42/44-character challenge and a 42/129-character verifier are invalid_request, and the code survives a malformed verifier', async () => {
    for (const challenge of ['A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}=`]) {
      const response = await authorize(baseParams(challenge));
      const location = new URL(response.headers.location);
      expect(`${location.origin}${location.pathname}`).toBe('http://127.0.0.1:61234/callback');
      expect(location.searchParams.get('error')).toBe('invalid_request');
      expect(location.searchParams.get('state')).toBe(STATE);
      expect(location.searchParams.get('iss')).toBe(MCP);
    }

    // RFC 7636 §4.1: 43–128 characters. 128 is accepted.
    const verifier = randomBytes(96).toString('base64url');
    expect(verifier).toHaveLength(128);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    keep(verifier, challenge, verifier.slice(0, 42), `${verifier}A`);
    const issued = await code(challenge);
    const form = {
      grant_type: 'authorization_code',
      code: issued,
      redirect_uri: 'http://127.0.0.1:61234/callback',
      client_id: BUILTIN,
    };
    for (const bad of [verifier.slice(0, 42), `${verifier}A`]) {
      const response = await token({ ...form, code_verifier: bad });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    }
    // A malformed verifier is refused before the code is touched.
    const ok = await token({ ...form, code_verifier: verifier });
    expect(ok.status).toBe(200);
    expect(ok.body.access_token).toMatch(/^assay_at_/);
  });

  it('resource at authorize: another origin is invalid_target; a path or none is accepted', async () => {
    for (const resource of [
      'https://evil.example',
      'https://mcp.example.test.evil.example/',
      'http://mcp.example.test/',
      'https://mcp.example.test:8443/',
    ]) {
      const response = await authorize(baseParams(pkce().challenge, { resource }));
      const location = new URL(response.headers.location);
      expect({ resource, error: location.searchParams.get('error') }).toEqual({
        resource,
        error: 'invalid_target',
      });
      expect(location.searchParams.get('state')).toBe(STATE);
      expect(location.searchParams.get('iss')).toBe(MCP);
    }
    for (const resource of [undefined, MCP, `${MCP}/`, `${MCP}/c/weather`, `${MCP}/@h/slug`]) {
      const response = await authorize(baseParams(pkce().challenge, { resource }));
      expect(response.headers.location.startsWith(`${WEB}/connect/authorize#request=`)).toBe(true);
    }
  });

  // ── DCR (§6.3.8) ────────────────────────────────────────────────────────────

  it('DCR over HTTP: secret methods refused', async () => {
    for (const body of [
      { token_endpoint_auth_method: 'client_secret_post' },
      { token_endpoint_auth_method: 'client_secret_basic' },
      { token_endpoint_auth_method: 'private_key_jwt' },
      { client_secret: 'chosen-by-the-client' },
    ]) {
      const response = await register({
        client_name: 'Secret Probe',
        redirect_uris: [LOOPBACK],
        ...body,
      });
      expect({ body, status: response.status, error: response.body.error }).toEqual({
        body,
        status: 400,
        error: 'invalid_client_metadata',
      });
    }
    // Refused before anything is stored.
    const [{ stored }] = (await dataSource.query(
      `SELECT count(*)::int AS "stored" FROM "oauth_clients" WHERE "client_name" = 'Secret Probe'`,
    )) as { stored: number }[];
    expect(stored).toBe(0);
  });

  it('DCR over HTTP: /64 rate key', async () => {
    const hex = () => randomBytes(2).toString('hex');
    const prefix = `2001:db8:${hex()}:${hex()}`;
    // Twenty from one /64, each from another interface id: all accepted.
    for (let i = 1; i <= 20; i += 1) {
      const response = await register(
        { client_name: 'Rate Probe', redirect_uris: [LOOPBACK] },
        `${prefix}::${i.toString(16)}`,
      );
      expect(response.status).toBe(201);
    }
    // The 21st from a new address in the same /64 is limited.
    const limited = await register(
      { client_name: 'Rate Probe', redirect_uris: [LOOPBACK] },
      `${prefix}:ffff:ffff:ffff:ffff`,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toMatch(/^\d+$/);
    // Another /64 is not.
    const other = await register(
      { client_name: 'Rate Probe', redirect_uris: [LOOPBACK] },
      `2001:db8:${hex()}:${hex()}::1`,
    );
    expect(other.status).toBe(201);
  });

  it('prune respects FK', async () => {
    // A DCR client 31 days old and referenced by nothing: a candidate.
    const [client] = (await dataSource.query(
      `INSERT INTO "oauth_clients"
         ("client_id", "kind", "client_name", "redirect_uris", "metadata", "created_at")
       VALUES ($1, 'DCR', 'Prune Probe', ARRAY['http://127.0.0.1/callback'], '{}',
               now() - interval '31 days')
       RETURNING "id"`,
      [`dcr_${randomBytes(16).toString('base64url').slice(0, 22)}`],
    )) as { id: string }[];

    // A grant for it is being written, not yet committed: the cleanup's
    // NOT EXISTS cannot see it, so only the foreign key can save the client.
    const writer = dataSource.createQueryRunner();
    await writer.connect();
    await writer.startTransaction();
    try {
      await writer.query(
        `INSERT INTO "agent_credentials"
           ("organization_id", "agent_id", "name", "prefix", "token_hash", "issued_via",
            "oauth_client_id", "expires_at")
         VALUES ($1, $2, 'Prune race', NULL, NULL, 'OAUTH', $3, now() + interval '30 days')`,
        [ORG, AGENT, client.id],
      );

      const [{ pid: writerPid }] = (await writer.query('SELECT pg_backend_pid() AS "pid"')) as {
        pid: number;
      }[];

      await redis.del(OAUTH_CLEANUP_LOCK_KEY);
      const cleanup = new OAuthCleanupService(dataSource, redis, {
        now: () => Date.now(),
        verifiedClientIds: [VENDOR],
      });
      const run = cleanup.run();

      // Wait until this run's client delete, in this database, is parked on
      // the writer's key-share lock (not some other run's delete elsewhere).
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = (await dataSource.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND $1 = ANY(pg_blocking_pids(pid))
              AND query LIKE 'DELETE FROM "oauth_clients"%'`,
          [writerPid],
        )) as unknown[];
        if (waiting.length > 0) break;
        if (Date.now() > deadline) throw new Error('the client delete never waited on the lock');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await writer.commitTransaction();

      // The delete hits the foreign key; the run keeps the client and goes on.
      const summary = await run;
      expect(summary).toEqual(expect.objectContaining({ skipped: false, clients: 0 }));
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release();
    }
    const kept = (await dataSource.query(`SELECT 1 FROM "oauth_clients" WHERE "id" = $1`, [
      client.id,
    ])) as unknown[];
    expect(kept).toHaveLength(1);
  });

  // ── frame and referrer (T8) ─────────────────────────────────────────────────

  it('the pages the MCP host serves itself carry no referrer, no script and no link', async () => {
    for (const page of [
      CONTINUE_WRONG_BROWSER_PAGE,
      CONTINUE_EXPIRED_PAGE,
      RATE_LIMITED_PAGE,
      UNAVAILABLE_PAGE,
    ]) {
      expect(page).toContain('<meta name="referrer" content="no-referrer">');
      expect(page).not.toMatch(/<script|<a\s|<form|<iframe|<img|<link|src=|href=|action=/i);
    }
    // As served: the wrong-browser page of a real continue has no button to
    // click-jack and nothing to leak the rid in its URL through.
    const { rid } = await start(pkce().challenge);
    const response = await request(mcp.getHttpServer()).get(
      `/oauth/authorize/continue?request=${encodeURIComponent(rid)}`,
    );
    expect(response.status).toBe(403);
    expect(response.text).toBe(CONTINUE_WRONG_BROWSER_PAGE);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).not.toContain(rid);
  });
  // ── logs (R-OA-27) and the network fence ────────────────────────────────────

  it('logs: authorize, consent, continue, token, refresh and revoke, with their error paths, under the real logger', async () => {
    const human = (call: request.Test) => call.set(auth);
    const decide = (rid: string, verb: 'approve' | 'deny') =>
      human(request(api.getHttpServer()).post(`/api/v1/oauth/requests/${rid}/${verb}`)).send(
        verb === 'approve' ? { agentId: AGENT, name: 'Conformance logs' } : {},
      );

    // authorize: refused before the redirect check, and after it.
    keepBody(
      await authorize(baseParams(pkce().challenge, { client_id: 'dcr_AAAAAAAAAAAAAAAAAAAAAA' })),
    );
    expect((await authorize(baseParams('short'))).status).toBe(302);
    expect(
      (await authorize(baseParams(pkce().challenge, { resource: 'https://evil.example' }))).status,
    ).toBe(302);

    // consent and continue: deny, a late approve (409), continue → access_denied.
    const denied = await start(pkce().challenge);
    keepBody(await readRequest(denied.rid));
    keepBody(await decide(denied.rid, 'deny'));
    expect(keepBody(await decide(denied.rid, 'approve')).status).toBe(409);
    expect((await resume(denied.rid, denied.cookie)).status).toBe(302);

    // continue: no cookie, another request's cookie, a malformed and an unknown rid.
    const stray = await start(pkce().challenge);
    const other = await start(pkce().challenge);
    expect(keepBody(await resume(stray.rid)).status).toBe(403);
    expect(keepBody(await resume(stray.rid, other.cookie)).status).toBe(403);
    expect(keepBody(await resume(`${stray.rid.slice(0, 40)}%`)).status).toBe(404);
    const unknownRid = randomBytes(32).toString('base64url');
    keep(unknownRid);
    expect(keepBody(await readRequest(unknownRid)).status).toBe(404);
    expect(keepBody(await decide(unknownRid, 'approve')).status).toBe(404);

    // token: a code burned by a wrong verifier, then a good exchange.
    const burnedPkce = pkce();
    const burned = await code(burnedPkce.challenge);
    const exchange = (issued: string, verifier: string) =>
      token({
        grant_type: 'authorization_code',
        code: issued,
        redirect_uri: 'http://127.0.0.1:61234/callback',
        client_id: BUILTIN,
        code_verifier: verifier,
      });
    expect((await exchange(burned, pkce().verifier)).status).toBe(400);
    expect((await exchange(burned, burnedPkce.verifier)).status).toBe(400);
    const goodPkce = pkce();
    const issued = await code(goodPkce.challenge);
    const pair = await exchange(issued, goodPkce.verifier);
    expect(pair.status).toBe(200);
    const malformedCode = `assay_ac_${randomBytes(32).toString('base64url')}`;
    keep(malformedCode);
    expect((await exchange(malformedCode, goodPkce.verifier)).status).toBe(400);

    // refresh: rotate, the grace answer, a wrong client, an unknown token.
    const refresh = (refreshToken: string, clientId = BUILTIN) =>
      token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    const rotated = await refresh(pair.body.refresh_token);
    expect(rotated.status).toBe(200);
    expect((await refresh(pair.body.refresh_token)).body.refresh_token).toBe(
      rotated.body.refresh_token,
    );
    expect((await refresh(rotated.body.refresh_token, 'dcr_AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(
      400,
    );
    const unknownRefresh = `assay_rt_${randomBytes(32).toString('base64url')}`;
    keep(unknownRefresh);
    expect((await refresh(unknownRefresh)).status).toBe(400);

    // The access token on the MCP endpoint, its revocation, then a 401.
    const call = (accessToken: string) =>
      request(mcp.getHttpServer())
        .post('/')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    keepBody(await call(rotated.body.access_token));
    const revoke = (value: string) =>
      request(mcp.getHttpServer())
        .post('/oauth/revoke')
        .set('X-Forwarded-For', newIp())
        .type('form')
        .send({ token: value, client_id: BUILTIN });
    expect((await revoke(rotated.body.access_token)).status).toBe(200);
    expect(keepBody(await call(rotated.body.access_token)).status).toBe(401);
    expect((await revoke(rotated.body.refresh_token)).status).toBe(200);
    expect((await revoke(unknownRefresh)).status).toBe(200);
    expect((await refresh(rotated.body.refresh_token)).status).toBe(400);
    // A replayed code, last: it revokes what it issued.
    expect((await exchange(issued, goodPkce.verifier)).status).toBe(400);
  });

  it('logs: nothing the suite captured holds a token, code, verifier, rid, state or cookie value', () => {
    const output = captured.join('');
    // Not vacuous: the real logger and the interceptor were on for every test.
    expect(output).toContain('"url":"/oauth/authorize"');
    expect(output).toContain('"url":"/oauth/authorize/continue"');
    expect(output).toContain('"url":"/oauth/token"');
    expect(output).toContain('"url":"/oauth/revoke"');
    expect(output).toContain('"url":"/oauth/register"');
    expect(output).toContain('/api/v1/oauth/requests/[REDACTED]');
    expect(bodies.length).toBeGreaterThan(10);
    expect(secrets.size).toBeGreaterThan(50);

    const errorBodies = bodies.join('\n');
    for (const secret of secrets) {
      const forms = [
        secret,
        digestToken(secret),
        createHash('sha256').update(secret).digest('base64url'),
      ];
      for (const form of forms) {
        if (output.includes(form)) throw new Error(`a secret reached the logs: …${form.slice(-6)}`);
        if (errorBodies.includes(form)) {
          throw new Error(`a secret reached an error body: …${form.slice(-6)}`);
        }
      }
    }
    for (const text of [output, errorBodies]) {
      expect(text).not.toMatch(/assay_(?:at|rt|ac)_[A-Za-z0-9_-]{8,}/);
      expect(text).not.toMatch(/code_verifier=/);
    }

    // No APM agent: nothing records spans that would need scrubbing.
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '../../../package.json'), 'utf8'),
    ) as Record<string, Record<string, string> | undefined>;
    const installed = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    });
    expect(
      installed.filter((name) =>
        /^(dd-trace|elastic-apm-node|newrelic|@opentelemetry\/|@sentry\/|@appsignal\/)/.test(name),
      ),
    ).toEqual([]);
  });

  it('no socket left this machine during the suite (the network fence)', () => {
    expect(blockedConnections).toEqual([]);
  });
});
