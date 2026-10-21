/**
 * The **only** place in `src/` that opens an outbound socket.
 *
 * Provider registration is open, with no manual approval, which means the URLs
 * this system fetches are, by design, typed by strangers. That makes every
 * outbound call a textbook SSRF vector from a malicious provider, and a
 * defence that lives in one client is only a defence if there is exactly one
 * client. Two rules keep it that way, and both fail the build rather than
 * warning:
 *
 * - `eslint.config.mjs` — `no-restricted-imports` on `axios`, `node-fetch`,
 *   `got`, `undici`, `node:http`, `node:https`, plus `no-restricted-globals` on
 *   `fetch`, everywhere under `src/` except this directory.
 * - `test/unit/shared/network/egress/single-http-client.spec.ts` — the same
 *   ban re-asserted by reading the source tree, so that deleting the lint rule
 *   turns a suite red instead of turning the rule off.
 *
 * The `eslint-disable` at the top of this file is the one exemption, and it is
 * here rather than in a config glob so that it shows up in a diff.
 *
 * ## What it guarantees
 *
 * | Guarantee | Mechanism |
 * |---|---|
 * | Only `http:` / `https:` | `resolveEgressTarget`, per hop |
 * | No private / loopback / link-local / metadata destination | `classifyAddress`, per hop, **after** DNS |
 * | No DNS rebinding | one lookup, then `lookup` pinned to that address on the socket |
 * | Redirects cannot smuggle a target past the check | every hop re-resolves and re-checks from scratch |
 * | No response bomb | `maxResponseBytes`, enforced on the declared length *and* on arrival |
 * | No slow-drip worker occupancy | per-hop header and body deadlines plus a total deadline |
 *
 * Every failure leaves as an {@link EgressError}, whose `code` Node-style
 * `EGRESS_*` token `classifyTransportError` recognises — so a call that trips
 * any limit lands on `SYSTEM_ERROR`: no charge, no strike, stake untouched.
 */

import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import * as http from 'node:http';
import * as https from 'node:https';
import { LookupAddress } from 'node:dns';
import { LookupFunction, isIP } from 'node:net';

import { EgressError, EgressFailureKind, withoutQuery } from './egress.errors';
import { EgressLimits, EgressPolicy, EgressTrust, UNTRUSTED_EGRESS_POLICY } from './egress.policy';
import { withSanctionedEgress } from './egress-lockdown';
import { EGRESS_RELAY_CONFIG, EgressRelayConfig } from './egress-relay.config';
import { EgressRelayTransport } from './egress-relay.transport';
import { EgressDnsLookup, EgressTarget, resolveEgressTarget } from './resolve-target';

export interface EgressRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Buffer;
  /**
   * Defaults to {@link UNTRUSTED_EGRESS_POLICY}.
   *
   * The default is the strict one on purpose: a call site that forgets to think
   * about trust gets the treatment appropriate to an attacker-supplied URL, and
   * a call site that needs less has to say so in a diff.
   */
  readonly policy?: EgressPolicy;
}

export interface EgressResponse {
  readonly status: number;
  /** Lower-cased header names, as `classifyResponse` expects. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bytes: number;
  /** The URL that actually answered — the last hop, not necessarily the first. */
  readonly url: string;
  readonly redirects: number;
}

/**
 * Overrides the DNS resolver. Unbound in production — it exists so a test can
 * point a public-looking hostname at a socket it controls without touching
 * `/etc/hosts` or the process-wide resolver.
 */
export const EGRESS_DNS_LOOKUP = Symbol('EGRESS_DNS_LOOKUP');

/**
 * Where the socket actually goes, once the destination has already been
 * approved. Unbound in production.
 *
 * This exists because of a genuine tension in testing an address blocklist:
 * every address that is *safe to fake* — `203.0.113.0/24`, `198.18.0.0/15`,
 * `127.0.0.0/8` — is an address this guard correctly refuses, and every address
 * it permits is one a test must not actually dial. A test therefore needs a
 * public-looking destination that terminates on a local server.
 *
 * Note carefully what this hook can and cannot do. It runs **after**
 * `resolveEgressTarget` has resolved and checked the address, and it changes
 * only the socket's destination. It cannot admit a blocked address, skip the
 * scheme check, or bypass the per-hop redirect re-check — those decisions are
 * already made on the real resolved address by the time it is consulted. The
 * worst it could do if it were ever bound in production is send approved
 * traffic to the wrong approved-looking place, which is a configuration bug,
 * not an SSRF bypass. That asymmetry is why the seam is here and not in the
 * address rules.
 */
export const EGRESS_CONNECT_OVERRIDE = Symbol('EGRESS_CONNECT_OVERRIDE');

/** See {@link EGRESS_CONNECT_OVERRIDE}. */
export type EgressConnectOverride = (
  target: EgressTarget,
) => { address: string; family: 4 | 6; port: number } | null;

/** Statuses that change the method to `GET` and drop the body, per RFC 9110. */
const REWRITE_TO_GET = new Set([301, 302, 303]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The only headers forwarded across an origin change.
 *
 * An allowlist, not a list of credential names: a provider binding
 * authenticates upstream with whatever header its API uses (`x-api-key`,
 * `x-auth-token`, …), and a blocklist of the well-known ones lets every other
 * one follow a redirect to a host nobody vetted.
 */
const CROSS_ORIGIN_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',
  'content-length',
  'user-agent',
  'x-assay-call-id',
]);

interface HopResponse {
  readonly kind: 'response';
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bytes: number;
}

interface HopRedirect {
  readonly kind: 'redirect';
  readonly status: number;
  readonly location: string;
}

type HopOutcome = HopResponse | HopRedirect;

@Injectable()
export class EgressHttpClient implements OnModuleDestroy {
  private readonly logger = new Logger(EgressHttpClient.name);

  /**
   * Set when `EGRESS_RELAY_URL` is configured. Used only for hops whose policy
   * says `relay: true`; everything else stays on the direct, unpooled path.
   */
  private readonly relay: EgressRelayTransport | null;

  /**
   * In production a `relay: true` hop with no relay configured is refused
   * rather than dialled: going direct would hand this server's IP to whoever
   * chose the URL.
   */
  private readonly relayRequired = process.env.NODE_ENV === 'production';

  constructor(
    @Optional() @Inject(EGRESS_DNS_LOOKUP) private readonly dnsLookup?: EgressDnsLookup,
    @Optional()
    @Inject(EGRESS_CONNECT_OVERRIDE)
    private readonly connectOverride?: EgressConnectOverride,
    @Optional() @Inject(EGRESS_RELAY_CONFIG) relayConfig?: EgressRelayConfig | null,
  ) {
    this.relay = relayConfig ? new EgressRelayTransport(relayConfig) : null;
  }

  onModuleDestroy(): void {
    this.relay?.close();
  }

  /**
   * Perform one outbound call, following redirects under the same checks.
   *
   * Throws {@link EgressError} and nothing else. It never returns a response
   * from an address the policy refuses, and it never runs longer than
   * `limits.totalTimeoutMs` — including the pathological cases, which is the
   * point.
   */
  async request(request: EgressRequest): Promise<EgressResponse> {
    const policy = request.policy ?? UNTRUSTED_EGRESS_POLICY;
    const limits = policy.limits;
    const deadline = Date.now() + limits.totalTimeoutMs;

    let currentUrl = request.url;
    let method = (request.method ?? 'GET').toUpperCase();
    let body = request.body;
    let headers = normalizeHeaders(request.headers);
    let origin: string | null = null;

    // A hop that must be relayed when no relay exists still gets the URL
    // checks (a bad scheme is the provider's fault, not ours), but never a
    // lookup — resolving the name already tells its nameserver about us — and
    // never a dial.
    const unrelayable = policy.relay && !this.relay && this.relayRequired;

    for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new EgressError(
          EgressFailureKind.TIMEOUT,
          `total request budget of ${limits.totalTimeoutMs}ms spent`,
          { url: currentUrl },
        );
      }

      // Resolution is inside the budget, not before it. `dns.lookup` takes no
      // timeout of its own, so an endpoint whose nameserver simply drops
      // queries would otherwise leave this `await` pending forever — no
      // deadline reached it, because every deadline started after it returned.
      // That is the worker-occupancy failure `EgressLimits` exists to prevent,
      // arrived at through the one call that was outside the fence.
      //
      // The resolver wraps a failed lookup as DNS_FAILED; the refusal is
      // passed through as the cause and taken back out here.
      const refusal = unrelayable ? relayRequired(currentUrl) : null;
      const target = await withDeadline(
        resolveEgressTarget(
          currentUrl,
          hopPolicy(policy, hop),
          refusal ? () => Promise.reject(refusal) : this.dnsLookup,
        ),
        remaining,
        currentUrl,
        'address resolution',
      ).catch((error: unknown) => {
        throw refusal && error instanceof EgressError && error.cause === refusal ? refusal : error;
      });
      if (refusal) throw refusal;

      if (origin !== null && target.url.origin !== origin) {
        headers = crossOriginHeaders(headers);
      }
      origin = target.url.origin;

      // No fallback: with the relay configured and asked for, a relay failure
      // is the answer, never a cue to dial the provider from here.
      const outcome =
        policy.relay && this.relay
          ? await this.relayHop(this.relay, target, method, headers, body, limits, deadline)
          : await this.hop(target, method, headers, body, limits, deadline);

      if (outcome.kind === 'response') {
        return {
          status: outcome.status,
          headers: outcome.headers,
          body: outcome.body,
          bytes: outcome.bytes,
          url: target.url.href,
          redirects: hop,
        };
      }

      const next = resolveLocation(outcome.location, target.url);
      // Origin and path only: see `withoutQuery`.
      this.logger.debug(
        `${outcome.status} ${withoutQuery(target.url.href)} → ${withoutQuery(next)}`,
      );
      assertRedirectAllowed(target.url, new URL(next), outcome.status, body !== undefined);

      if (REWRITE_TO_GET.has(outcome.status) && method !== 'HEAD') {
        method = 'GET';
        body = undefined;
        headers = withoutBodyHeaders(headers);
      }

      currentUrl = next;
    }

    throw new EgressError(
      EgressFailureKind.TOO_MANY_REDIRECTS,
      `exceeded ${limits.maxRedirects} redirects`,
      { url: currentUrl },
    );
  }

  // ── One hop, through the relay ─────────────────────────────────────────────

  /**
   * The target was resolved and checked by the caller exactly as for a direct
   * hop; only the socket is different. A `3xx` comes back as a redirect so the
   * loop re-checks the next target here before the relay ever sees it.
   */
  private async relayHop(
    relay: EgressRelayTransport,
    target: EgressTarget,
    method: string,
    headers: Record<string, string>,
    body: string | Buffer | undefined,
    limits: EgressLimits,
    deadline: number,
  ): Promise<HopOutcome> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new EgressError(EgressFailureKind.TIMEOUT, 'total request budget already spent', {
        url: target.url.href,
      });
    }

    const response = await relay.send(
      { url: target.url.href, method, headers, body },
      { ...limits, totalTimeoutMs: remaining },
    );

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers['location'];
      if (!location) {
        throw new EgressError(
          EgressFailureKind.REDIRECT_INVALID,
          `${response.status} with no Location header`,
          { url: target.url.href },
        );
      }
      return { kind: 'redirect', status: response.status, location };
    }

    return {
      kind: 'response',
      status: response.status,
      headers: response.headers,
      body: response.body.toString('utf8'),
      bytes: response.body.length,
    };
  }

  // ── One hop ───────────────────────────────────────────────────────────────

  private hop(
    target: EgressTarget,
    method: string,
    headers: Record<string, string>,
    body: string | Buffer | undefined,
    limits: EgressLimits,
    deadline: number,
  ): Promise<HopOutcome> {
    const transport = target.url.protocol === 'https:' ? https : http;
    // Already approved by `resolveEgressTarget`; this only decides which socket
    // an approved destination lands on. See `EGRESS_CONNECT_OVERRIDE`.
    const wire = this.connectOverride?.(target) ?? target;
    const hostname = target.url.hostname.replace(/^\[|\]$/g, '');

    return new Promise<HopOutcome>((resolve, reject) => {
      let settled = false;
      let headersTimer: NodeJS.Timeout | undefined;
      let bodyTimer: NodeJS.Timeout | undefined;
      let received = 0;
      const chunks: Buffer[] = [];

      const clearTimers = (): void => {
        if (headersTimer) clearTimeout(headersTimer);
        if (bodyTimer) clearTimeout(bodyTimer);
        headersTimer = undefined;
        bodyTimer = undefined;
      };

      /**
       * Settle exactly once, and always tear the socket down.
       *
       * Destroying on the success path too is not redundant: `agent: false`
       * still leaves the socket open until the response stream ends, and a
       * server that sends a complete body and then keeps the connection alive
       * would otherwise hold a handle for as long as it likes.
       */
      const finish = (outcome: HopOutcome | EgressError): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        req.destroy();
        if (outcome instanceof EgressError) reject(outcome);
        else resolve(outcome);
      };

      const partial = (): string | null =>
        chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null;

      const budget = (want: number): number => {
        const remaining = deadline - Date.now();
        return Math.max(1, Math.min(want, remaining));
      };

      if (deadline - Date.now() <= 0) {
        reject(
          new EgressError(EgressFailureKind.TIMEOUT, 'total request budget already spent', {
            url: target.url.href,
          }),
        );
        return;
      }

      // Only the `transport.request` call is inside the sanctioned scope, and
      // the response handler is attached *outside* it — a callback registered
      // inside an `AsyncLocalStorage` scope runs inside it, so registering the
      // response handler there would leave every `res.on('data')` running
      // sanctioned. Nothing caller-supplied reaches that path today; this keeps
      // it that way if something ever does.
      const req = withSanctionedEgress(() =>
        transport.request(
          {
            protocol: target.url.protocol,
            // For a hostname, `host` stays the hostname: `pinnedLookup` is what
            // decides the address, and TLS derives `servername` from this, so
            // certificate validation is against the name the caller asked for.
            //
            // For an IP literal, Node's `lookupAndConnect` short-circuits on
            // `isIP(host)` and never calls `lookup` at all — so the address has
            // to be passed here or the pin is silently not the thing connecting.
            // It is the same value either way (`resolveEgressTarget` sets
            // `address` from the literal), except under
            // `EGRESS_CONNECT_OVERRIDE`, which is the case that made the gap
            // visible.
            host: isIP(hostname) ? wire.address : hostname,
            port: wire.port,
            method,
            path: `${target.url.pathname}${target.url.search}`,
            // `host` is set from the URL, not from the socket. `setHost: false`
            // because Node would derive it from `options.port` — which is the
            // wire port, and under `EGRESS_CONNECT_OVERRIDE` that is not the port
            // the far end believes it is serving.
            headers: { ...headers, host: target.url.host },
            // Pinned. This is the anti-rebinding step: the socket is opened to
            // the address `resolveEgressTarget` checked, and the name is never
            // resolved a second time.
            lookup: pinnedLookup(wire.address, wire.family),
            // No pooling. A pooled socket is a socket whose `lookup` ran for some
            // earlier request under some earlier policy.
            agent: false,
            setHost: false,
          },
          (res) => {
            if (headersTimer) clearTimeout(headersTimer);

            const responseHeaders = flattenHeaders(res.headers);
            const status = res.statusCode ?? 0;

            if (REDIRECT_STATUSES.has(status)) {
              const location = responseHeaders['location'];
              if (!location) {
                finish(
                  new EgressError(
                    EgressFailureKind.REDIRECT_INVALID,
                    `${status} with no Location header`,
                    { url: target.url.href },
                  ),
                );
                return;
              }
              finish({ kind: 'redirect', status, location });
              return;
            }

            const declared = Number(responseHeaders['content-length']);
            if (Number.isFinite(declared) && declared > limits.maxResponseBytes) {
              finish(
                new EgressError(
                  EgressFailureKind.RESPONSE_TOO_LARGE,
                  `Content-Length ${declared} exceeds the ${limits.maxResponseBytes} byte cap`,
                  { url: target.url.href, address: target.address },
                ),
              );
              return;
            }

            // A total budget, not an idle one — see `EgressLimits.bodyTimeoutMs`.
            bodyTimer = setTimeout(() => {
              finish(
                new EgressError(
                  EgressFailureKind.TIMEOUT,
                  `body did not complete within ${limits.bodyTimeoutMs}ms`,
                  {
                    url: target.url.href,
                    address: target.address,
                    partialBody: partial(),
                  },
                ),
              );
            }, budget(limits.bodyTimeoutMs));

            res.on('data', (chunk: Buffer) => {
              received += chunk.length;
              if (received > limits.maxResponseBytes) {
                finish(
                  new EgressError(
                    EgressFailureKind.RESPONSE_TOO_LARGE,
                    `body passed the ${limits.maxResponseBytes} byte cap`,
                    {
                      url: target.url.href,
                      address: target.address,
                      partialBody: partial(),
                    },
                  ),
                );
                return;
              }
              chunks.push(chunk);
            });

            res.on('end', () => {
              finish({
                kind: 'response',
                status,
                headers: responseHeaders,
                body: Buffer.concat(chunks).toString('utf8'),
                bytes: received,
              });
            });

            res.on('error', (error: NodeJS.ErrnoException) => {
              finish(
                new EgressError(EgressFailureKind.CONNECTION_FAILED, describe(error), {
                  url: target.url.href,
                  address: target.address,
                  partialBody: partial(),
                  cause: error,
                }),
              );
            });
          },
        ),
      );

      headersTimer = setTimeout(() => {
        finish(
          new EgressError(
            EgressFailureKind.TIMEOUT,
            `no response headers within ${limits.headersTimeoutMs}ms`,
            { url: target.url.href, address: target.address },
          ),
        );
      }, budget(limits.headersTimeoutMs));

      req.on('error', (error: NodeJS.ErrnoException) => {
        // Reached after our own `req.destroy()` too; `settled` makes that a
        // no-op so the real reason is the one that surfaces.
        finish(
          new EgressError(EgressFailureKind.CONNECTION_FAILED, describe(error), {
            url: target.url.href,
            address: target.address,
            partialBody: partial(),
            cause: error,
          }),
        );
      });

      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The policy for one hop.
 *
 * `EgressTrust.INTERNAL_ALLOWED` says "the operator vouched for **this URL**".
 * It does not say "the operator vouched for wherever this URL points", and
 * those are very different statements: a `Location` header is chosen by the far
 * end, not by the operator. Leaving the relaxation in place across a redirect
 * would hand our own facilitator — or a third-party one, or a
 * compromised Kora — an unrestricted SSRF primitive into the VPC through a
 * single response header.
 *
 * So the trust level survives exactly one hop. Everything after it is treated
 * as what it is: an address a remote party asked us to dial.
 */
function hopPolicy(policy: EgressPolicy, hop: number): EgressPolicy {
  if (hop === 0 || policy.trust === EgressTrust.PUBLIC_ONLY) return policy;
  // Frozen like every other policy in the module. Nothing can currently mutate
  // this object — it is built per hop and discarded — but a policy that is
  // frozen everywhere except on the path that *tightens* it is an invariant
  // with one hole in exactly the wrong place.
  return Object.freeze({ ...policy, trust: EgressTrust.PUBLIC_ONLY });
}

/**
 * Bound a promise that has no deadline of its own.
 *
 * Caveat worth knowing: this bounds the *promise*, which is what frees the
 * worker slot. `dns.lookup` runs on the libuv threadpool and cannot be
 * cancelled, so the thread stays occupied until the OS resolver gives up. Four
 * concurrent blackholed lookups will still stall other threadpool work
 * (`fs.*`, `crypto.pbkdf2`, and further lookups) for as long as that takes.
 * Closing that fully means resolving through c-ares (`dns.resolve4`/`resolve6`,
 * event-loop, genuinely cancellable) and giving up `/etc/hosts`.
 */
function withDeadline<T>(work: Promise<T>, ms: number, url: string, what: string): Promise<T> {
  let timer: NodeJS.Timeout;

  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new EgressError(EgressFailureKind.TIMEOUT, `${what} did not complete within ${ms}ms`, {
            url,
          }),
        ),
      ms,
    );
  });

  return Promise.race([work, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * A `lookup` that answers with one address and never consults DNS.
 *
 * Deferred with `setImmediate` because `net.Socket.connect` is written against
 * an asynchronous resolver and checks `self.destroyed` when the callback runs;
 * answering synchronously re-enters connect logic that has not finished setting
 * itself up.
 */
function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((hostname: string, options: unknown, callback: unknown): void => {
    setImmediate(() => {
      const wantsAll = Boolean((options as { all?: boolean } | undefined)?.all);
      if (wantsAll) {
        (callback as (e: null, a: LookupAddress[]) => void)(null, [{ address, family }]);
      } else {
        (callback as (e: null, a: string, f: number) => void)(null, address, family);
      }
    });
  }) as unknown as LookupFunction;
}

function normalizeHeaders(headers?: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name.toLowerCase()] = value;
  }
  // Identity encoding, deliberately. `maxResponseBytes` counts wire bytes; a
  // compressed body would let a 5 MB cap admit a decompressed gigabyte.
  out['accept-encoding'] = 'identity';
  return out;
}

function crossOriginHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (CROSS_ORIGIN_HEADERS.has(name)) out[name] = value;
  }
  return out;
}

/**
 * Refuse the redirects that would leak what the first hop was trusted with.
 *
 * - `https:` → `http:` on any hop: the request, and whatever credentials are
 *   still on it, would cross the network in clear.
 * - A `307`/`308` to another origin while a body is being sent: those
 *   statuses keep the method and body, so the buyer's payload would be
 *   replayed to a host nobody chose.
 */
export function assertRedirectAllowed(from: URL, to: URL, status: number, hasBody: boolean): void {
  if (from.protocol === 'https:' && to.protocol === 'http:') {
    throw new EgressError(EgressFailureKind.REDIRECT_INVALID, 'refused an https → http redirect', {
      url: from.href,
    });
  }
  if (hasBody && !REWRITE_TO_GET.has(status) && from.origin !== to.origin) {
    throw new EgressError(
      EgressFailureKind.REDIRECT_INVALID,
      `refused a ${status} redirect that would resend the request body to another origin`,
      { url: from.href },
    );
  }
}

function withoutBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const out = { ...headers };
  delete out['content-length'];
  delete out['content-type'];
  return out;
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function resolveLocation(location: string, base: URL): string {
  try {
    return new URL(location, base).href;
  } catch (error) {
    throw new EgressError(
      EgressFailureKind.REDIRECT_INVALID,
      `unparseable Location "${withoutQuery(location)}"`,
      {
        url: base.href,
        cause: error,
      },
    );
  }
}

function describe(error: NodeJS.ErrnoException): string {
  return error.code ? `${error.code}: ${error.message}` : error.message;
}

/** A hop that must go through the relay, with none configured (production). */
function relayRequired(url: string): EgressError {
  return new EgressError(
    EgressFailureKind.RELAY_UNAVAILABLE,
    'this call must go through the egress relay, and none is configured',
    { url },
  );
}
