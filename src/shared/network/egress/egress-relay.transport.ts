/**
 * One hop through the egress relay (protocol v1).
 *
 * The relay is a Cloudflare Worker (`workers/egress-relay/`) that performs the
 * provider call so the provider never sees this server's IP. It is a transport
 * only: by the time a hop reaches {@link EgressRelayTransport.send},
 * `EgressHttpClient` has already resolved the target, checked the address and,
 * for a redirect, re-checked it from scratch. The Worker never follows
 * redirects; a `3xx` comes back here and goes through the same loop.
 *
 * ```text
 * POST {EGRESS_RELAY_URL}/v1/relay
 * authorization: Bearer <token>
 * { url, method, headers, body, timeoutMs, maxResponseBytes }
 *
 * provider answer → its status/headers/body + x-assay-relay: upstream
 * relay failure   → 502 + x-assay-relay: error + { kind }
 * no header       → not the relay talking (a Cloudflare error page): unavailable
 * ```
 *
 * The Worker's own `{ kind: "TIMEOUT" }` is the authoritative "provider was
 * slow"; a deadline expiring on this side means the relay stalled.
 *
 * Every failure of the relay itself is `RELAY_UNAVAILABLE` — Assay's fault,
 * never counted against the provider — and there is no fallback to a direct
 * call. The token is only ever written into the request header: no error, log
 * line or error context built here contains it.
 */

import { isUtf8 } from 'node:buffer';
import * as http from 'node:http';
import * as https from 'node:https';

import { EgressError, EgressFailureKind } from './egress.errors';
import { EgressLimits } from './egress.policy';
import { EgressRelayConfig, RELAY_ALLOWED_PORTS, isIpLiteralHost } from './egress-relay.config';
import { withSanctionedEgress } from './egress-lockdown';

export interface RelayHop {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string | Buffer;
}

export interface RelayedResponse {
  readonly status: number;
  /** Lower-cased; the relay's own `x-assay-relay` marker removed. */
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

const RELAY_HEADER = 'x-assay-relay';
const RELAY_PATH = '/v1/relay';

/** The relay's own failure kinds that say "the provider did this". */
const MAPPED_KINDS: Readonly<Record<string, EgressFailureKind>> = Object.freeze({
  TIMEOUT: EgressFailureKind.TIMEOUT,
  CONNECT: EgressFailureKind.CONNECTION_FAILED,
  BLOCKED_TARGET: EgressFailureKind.BLOCKED_ADDRESS,
  TOO_LARGE: EgressFailureKind.RESPONSE_TOO_LARGE,
});

/** Headers that describe the relay leg, not the provider's answer. */
const RELAY_LEG_HEADERS = new Set([RELAY_HEADER, 'connection', 'keep-alive', 'transfer-encoding']);

/** Headers the envelope does not carry: the Worker sets framing for its own leg. */
const ENVELOPE_DROP = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

/** Enough to read `{"kind":"..."}`; an error body larger than this is not the relay's. */
const MAX_ERROR_BODY_BYTES = 4096;

/**
 * The relay leg's own deadline sits this far past the envelope's `timeoutMs`,
 * so a slow provider is reported by the Worker as `{ kind: "TIMEOUT" }` — the
 * authoritative "provider was slow" — before any timer here fires. A timer
 * here firing therefore means the relay itself stalled.
 */
export const RELAY_TIMEOUT_MARGIN_MS = 1_500;
/** The Worker is never given less than this to reach the provider. */
export const RELAY_MIN_TIMEOUT_MS = 1_000;

/**
 * Idle pooled sockets are dropped after this, well below typical edge
 * keep-alive, so a socket the far end already closed is rarely reused.
 */
const RELAY_IDLE_SOCKET_MS = 30_000;

export interface EgressRelayTransportOptions {
  /** Tests only; production uses the default. */
  readonly maxSockets?: number;
}

export class EgressRelayTransport {
  private readonly agent: http.Agent;
  private readonly module: typeof http | typeof https;
  private readonly endpoint: URL;
  /** ES-private, so `util.inspect` and JSON serialisation never see it. */
  readonly #authorization: string;

  constructor(config: EgressRelayConfig, options: EgressRelayTransportOptions = {}) {
    this.endpoint = new URL(RELAY_PATH, config.url);
    const secure = this.endpoint.protocol === 'https:';
    this.module = secure ? https : http;
    // One pool, bound to the fixed relay host. Pooling is safe here and only
    // here: the relay is operator config, and the provider's address was
    // already checked before the hop was handed over.
    const agentOptions = {
      keepAlive: true,
      maxSockets: options.maxSockets ?? 256,
      timeout: RELAY_IDLE_SOCKET_MS,
    };
    this.agent = secure ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
    this.#authorization = `Bearer ${config.token}`;
  }

  /** Close pooled sockets. Called on module shutdown. */
  close(): void {
    this.agent.destroy();
  }

  /**
   * Relay one hop. `limits.totalTimeoutMs` is the budget left for this hop.
   *
   * The Worker gets `timeoutMs` = that budget minus {@link RELAY_TIMEOUT_MARGIN_MS}
   * (bounded by the per-hop headers + body limits, floor
   * {@link RELAY_MIN_TIMEOUT_MS}); the relay leg here runs on one deadline that
   * margin later. Expiry of that deadline — connect, headers or body — is
   * `RELAY_UNAVAILABLE`. The byte cap applies on declared and on arrived length.
   */
  send(hop: RelayHop, limits: EgressLimits): Promise<RelayedResponse> {
    assertRelayable(hop);

    const budget = Math.max(1, Math.floor(limits.totalTimeoutMs));
    const workerTimeoutMs = Math.max(
      RELAY_MIN_TIMEOUT_MS,
      Math.min(limits.headersTimeoutMs + limits.bodyTimeoutMs, budget - RELAY_TIMEOUT_MARGIN_MS),
    );
    const legTimeoutMs = Math.min(budget, workerTimeoutMs + RELAY_TIMEOUT_MARGIN_MS);

    const envelope = Buffer.from(
      JSON.stringify({
        url: hop.url,
        method: hop.method,
        headers: envelopeHeaders(hop.headers),
        body: hop.body === undefined ? null : hop.body.toString('utf8'),
        timeoutMs: workerTimeoutMs,
        maxResponseBytes: limits.maxResponseBytes,
      }),
      'utf8',
    );

    return new Promise<RelayedResponse>((resolve, reject) => {
      let settled = false;

      // A failure destroys the socket (it may be mid-body); a success leaves
      // it in the pool, which is the point of the keep-alive agent.
      const fail = (error: EgressError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(legTimer);
        req.destroy();
        reject(error);
      };

      const succeed = (response: RelayedResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(legTimer);
        resolve(response);
      };

      const unavailable = (detail: string, cause?: unknown): EgressError =>
        new EgressError(EgressFailureKind.RELAY_UNAVAILABLE, detail, {
          url: hop.url,
          ...(cause === undefined ? {} : { cause: redact(cause, this.#authorization) }),
        });

      const req = withSanctionedEgress(() =>
        this.module.request(this.endpoint, {
          method: 'POST',
          agent: this.agent,
          headers: {
            authorization: this.#authorization,
            'content-type': 'application/json',
            'content-length': String(envelope.length),
          },
        }),
      );

      // One deadline for the whole leg: connect, headers and body.
      const legTimer = setTimeout(() => {
        fail(unavailable(`relay did not answer within ${legTimeoutMs}ms`));
      }, legTimeoutMs);

      req.on('response', (res: http.IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const headers = flatten(res.headers);
        const marker = headers[RELAY_HEADER];

        if (marker !== 'upstream' && marker !== 'error') {
          res.resume();
          fail(unavailable(`relay answered ${status} without the protocol header`));
          return;
        }

        const isError = marker === 'error';
        const cap = isError ? MAX_ERROR_BODY_BYTES : limits.maxResponseBytes;

        const declared = Number(headers['content-length']);
        if (!isError && Number.isFinite(declared) && declared > cap) {
          fail(
            new EgressError(
              EgressFailureKind.RESPONSE_TOO_LARGE,
              `Content-Length ${declared} exceeds the ${cap} byte cap`,
              { url: hop.url },
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > cap) {
            fail(
              isError
                ? unavailable('relay error body too large')
                : new EgressError(
                    EgressFailureKind.RESPONSE_TOO_LARGE,
                    `body passed the ${cap} byte cap`,
                    { url: hop.url, partialBody: partial(chunks) },
                  ),
            );
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (!isError) {
            succeed({ status, headers: withoutRelayLeg(headers), body });
            return;
          }
          const kind = relayErrorKind(body);
          const mapped = kind ? MAPPED_KINDS[kind] : undefined;
          if (mapped) {
            fail(new EgressError(mapped, `relay reported ${kind}`, { url: hop.url }));
          } else {
            fail(unavailable(kind ? `relay reported ${kind}` : 'unreadable relay error'));
          }
        });

        res.on('error', (error: Error) => {
          fail(unavailable('relay connection failed', error));
        });
      });

      req.on('error', (error: Error) => {
        fail(unavailable('relay connection failed', error));
      });

      req.end(envelope);
    });
  }
}

/**
 * Refuse, before anything is sent, a hop the Worker cannot carry: it fetches
 * `https:` only, never an IP-literal host, and only on Cloudflare's allowed
 * ports. That is the provider's URL being unusable, not the relay failing.
 * Protocol v1 carries the body as a UTF-8 string, so a binary body is refused
 * rather than silently corrupted.
 */
function assertRelayable(hop: RelayHop): void {
  const url = new URL(hop.url);
  const refuse = (detail: string): never => {
    throw new EgressError(EgressFailureKind.URL_INVALID, detail, { url: hop.url });
  };
  if (url.protocol !== 'https:') refuse('provider calls through the relay must use https');
  if (isIpLiteralHost(url.hostname)) {
    refuse('provider calls through the relay need a hostname, not an IP address');
  }
  if (url.port !== '' && !RELAY_ALLOWED_PORTS.includes(Number(url.port))) {
    refuse(`port ${url.port} is not one the relay can reach (${RELAY_ALLOWED_PORTS.join(', ')})`);
  }
  if (Buffer.isBuffer(hop.body) && !isUtf8(hop.body)) {
    refuse('request body is not UTF-8; the relay carries UTF-8 bodies only');
  }
}

function envelopeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!ENVELOPE_DROP.has(lower)) out[lower] = value;
  }
  return out;
}

function withoutRelayLeg(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!RELAY_LEG_HEADERS.has(name)) out[name] = value;
  }
  return out;
}

function relayErrorKind(body: Buffer): string | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { kind?: unknown };
    return typeof parsed?.kind === 'string' && /^[A-Z_]{1,32}$/.test(parsed.kind)
      ? parsed.kind
      : null;
  } catch {
    return null;
  }
}

function partial(chunks: readonly Buffer[]): string | null {
  return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null;
}

function flatten(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/**
 * A socket error, reduced to its code and a message with the bearer removed.
 *
 * Node's socket errors do not carry request headers today; this keeps it that
 * way for whatever wraps them tomorrow.
 */
function redact(error: unknown, authorization: string): Error {
  const source = error as { code?: unknown; message?: unknown };
  const message = typeof source?.message === 'string' ? source.message : 'relay socket error';
  const token = authorization.slice('Bearer '.length);
  const clean = new Error(message.split(token).join('[redacted]'));
  if (typeof source?.code === 'string') {
    (clean as NodeJS.ErrnoException).code = source.code;
  }
  return clean;
}
