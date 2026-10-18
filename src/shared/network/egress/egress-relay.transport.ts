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
 * Every failure of the relay itself is `RELAY_UNAVAILABLE` — Assay's fault,
 * never counted against the provider — and there is no fallback to a direct
 * call. The token is only ever written into the request header: no error, log
 * line or error context built here contains it.
 */

import * as http from 'node:http';
import * as https from 'node:https';

import { EgressError, EgressFailureKind } from './egress.errors';
import { EgressLimits } from './egress.policy';
import { EgressRelayConfig } from './egress-relay.config';
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

export class EgressRelayTransport {
  private readonly agent: http.Agent;
  private readonly module: typeof http | typeof https;
  private readonly endpoint: URL;
  private readonly authorization: string;

  constructor(config: EgressRelayConfig) {
    this.endpoint = new URL(RELAY_PATH, config.url);
    const secure = this.endpoint.protocol === 'https:';
    this.module = secure ? https : http;
    // One pool, bound to the fixed relay host. Pooling is safe here and only
    // here: the relay is operator config, and the provider's address was
    // already checked before the hop was handed over.
    this.agent = secure
      ? new https.Agent({ keepAlive: true, maxSockets: 256 })
      : new http.Agent({ keepAlive: true, maxSockets: 256 });
    this.authorization = `Bearer ${config.token}`;
  }

  /** Close pooled sockets. Called on module shutdown. */
  close(): void {
    this.agent.destroy();
  }

  /**
   * Relay one hop. `limits.totalTimeoutMs` is the budget left for this hop.
   *
   * The client's limits apply to the relay leg as they would to a direct one:
   * a headers deadline, a body deadline, and the byte cap on declared and on
   * arrived length.
   */
  send(hop: RelayHop, limits: EgressLimits): Promise<RelayedResponse> {
    const budget = Math.max(1, Math.floor(limits.totalTimeoutMs));
    const startedAt = Date.now();
    const remaining = (want: number): number =>
      Math.max(1, Math.min(want, budget - (Date.now() - startedAt)));

    const envelope = Buffer.from(
      JSON.stringify({
        url: hop.url,
        method: hop.method,
        headers: envelopeHeaders(hop.headers),
        body: hop.body === undefined ? null : hop.body.toString('utf8'),
        timeoutMs: budget,
        maxResponseBytes: limits.maxResponseBytes,
      }),
      'utf8',
    );

    return new Promise<RelayedResponse>((resolve, reject) => {
      let settled = false;
      let headersTimer: NodeJS.Timeout | undefined;
      let bodyTimer: NodeJS.Timeout | undefined;

      const clearTimers = (): void => {
        if (headersTimer) clearTimeout(headersTimer);
        if (bodyTimer) clearTimeout(bodyTimer);
        headersTimer = undefined;
        bodyTimer = undefined;
      };

      // A failure destroys the socket (it may be mid-body); a success leaves
      // it in the pool, which is the point of the keep-alive agent.
      const fail = (error: EgressError): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        req.destroy();
        reject(error);
      };

      const succeed = (response: RelayedResponse): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve(response);
      };

      const unavailable = (detail: string, cause?: unknown): EgressError =>
        new EgressError(EgressFailureKind.RELAY_UNAVAILABLE, detail, {
          url: hop.url,
          ...(cause === undefined ? {} : { cause: redact(cause, this.authorization) }),
        });

      const req = withSanctionedEgress(() =>
        this.module.request(this.endpoint, {
          method: 'POST',
          agent: this.agent,
          headers: {
            authorization: this.authorization,
            'content-type': 'application/json',
            'content-length': String(envelope.length),
          },
        }),
      );

      req.on('response', (res: http.IncomingMessage) => {
        if (headersTimer) clearTimeout(headersTimer);
        headersTimer = undefined;

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

        bodyTimer = setTimeout(() => {
          fail(
            new EgressError(
              EgressFailureKind.TIMEOUT,
              `body did not complete within ${limits.bodyTimeoutMs}ms`,
              { url: hop.url, partialBody: partial(chunks) },
            ),
          );
        }, remaining(limits.bodyTimeoutMs));

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

      headersTimer = setTimeout(() => {
        fail(
          new EgressError(
            EgressFailureKind.TIMEOUT,
            `no response headers within ${limits.headersTimeoutMs}ms`,
            { url: hop.url },
          ),
        );
      }, remaining(limits.headersTimeoutMs));

      req.end(envelope);
    });
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
