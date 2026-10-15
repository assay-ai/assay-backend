/**
 * Turning a thrown Node/undici error into a `TransportError`.
 *
 * Everything recognised here is `SYSTEM_ERROR`, so getting a *kind* wrong costs
 * a diagnostic label, never a slash. What must not happen is the opposite
 * mistake: an error the recogniser fails to recognise leaking upward as though
 * the call had succeeded. That is why {@link classifyTransportError} always
 * returns a `TransportError` — there is no "not a transport error" return
 * value. If the call path caught something, the call failed.
 */

import { TransportError, TransportErrorKind } from './classification.types';

/**
 * `fetch` wraps the real failure: `TypeError: fetch failed` with the socket
 * error hanging off `.cause`, which itself may wrap another. The recogniser
 * walks the chain rather than inspecting the top frame, because the top frame
 * is almost always the useless one.
 */
function causeChain(error: unknown, limit = 8): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current != null && chain.length < limit) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Error codes/names, most specific first.
 *
 * Ordering matters in exactly one place: `ETIMEDOUT` can surface as the cause
 * under a connect failure, and `UND_ERR_CONNECT_TIMEOUT` is the more precise
 * label, so timeouts are matched before connection faults.
 */
const KIND_BY_CODE: ReadonlyArray<readonly [RegExp, TransportErrorKind]> = [
  // Our own egress guard, first, because it is the most specific thing in the
  // chain when it is present. `EgressError` deliberately exposes its code as
  // `.code` (see `src/shared/network/egress/egress.errors.ts`) so that it reads
  // exactly like a Node error here and needs no separate entry point.
  //
  // Every kind maps to a `TransportErrorKind`, so every refused or truncated
  // outbound call is `SYSTEM_ERROR`: no charge, no strike, stake untouched. A
  // provider whose endpoint we declined to dial has not been shown to have done
  // anything wrong — we simply have no observation to judge.
  [/^EGRESS_TIMEOUT$/, TransportErrorKind.TIMEOUT],
  [/^EGRESS_DNS_FAILED$/, TransportErrorKind.DNS_FAILURE],
  [/^EGRESS_CONNECTION_FAILED$/, TransportErrorKind.CONNECTION_RESET],
  [/^EGRESS_RESPONSE_TOO_LARGE$/, TransportErrorKind.BODY_TRUNCATED],
  // Its own kind so the provider is told why (https required in production)
  // rather than an UNKNOWN transport failure.
  [/^EGRESS_SCHEME_NOT_ALLOWED$/, TransportErrorKind.SCHEME_NOT_ALLOWED],
  [
    /^EGRESS_(URL_INVALID|BLOCKED_ADDRESS|REDIRECT_INVALID|TOO_MANY_REDIRECTS)$/,
    TransportErrorKind.UNKNOWN,
  ],

  // Deadlines. `AbortError` is here because the only thing that aborts a
  // provider call in this system is `tool.timeoutMs` expiring — there is no
  // user-initiated cancel on a path an agent is blocked on.
  [/^(AbortError|TimeoutError)$/, TransportErrorKind.TIMEOUT],
  [/^UND_ERR_(HEADERS_TIMEOUT|BODY_TIMEOUT|CONNECT_TIMEOUT)$/, TransportErrorKind.TIMEOUT],
  [/^(ETIMEDOUT|ESOCKETTIMEDOUT)$/, TransportErrorKind.TIMEOUT],

  // Name resolution. Checked before the generic connect failures because a
  // stale endpoint in a binding is a different operational problem from a
  // provider being down, and only this kind tells them apart.
  [/^(ENOTFOUND|EAI_AGAIN)$/, TransportErrorKind.DNS_FAILURE],

  // TLS. `EPROTO` is included: in practice it is a handshake failure against a
  // plaintext port far more often than anything else.
  [
    /^(EPROTO|ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_(VERIFY|GET)_)/,
    TransportErrorKind.TLS_FAILURE,
  ],
  [/^ERR_TLS_CERT_ALTNAME_INVALID$/, TransportErrorKind.TLS_FAILURE],

  [/^ECONNREFUSED$/, TransportErrorKind.CONNECTION_REFUSED],

  // Framing said one length, the wire delivered another. Named separately from
  // a reset because the incompleteness is *provable* here rather than inferred.
  [
    /^(UND_ERR_REQ_CONTENT_LENGTH_MISMATCH|UND_ERR_RES_CONTENT_LENGTH_MISMATCH|ERR_STREAM_PREMATURE_CLOSE)$/,
    TransportErrorKind.BODY_TRUNCATED,
  ],

  // The socket died. `UND_ERR_SOCKET` is undici's wrapper for "other side went
  // away", which is what a server closing mid-body looks like from here.
  [
    /^(ECONNRESET|EPIPE|ECONNABORTED|UND_ERR_SOCKET|ERR_SOCKET_CONNECTION_TIMEOUT)$/,
    TransportErrorKind.CONNECTION_RESET,
  ],
];

/**
 * Message-shape fallbacks, for the failures Node reports without a `code`.
 *
 * undici's `TypeError: terminated` is the important one: it is what a body
 * stream throws when the peer closes the connection before the declared body is
 * complete, and it arrives with no code of its own on some Node versions.
 */
const KIND_BY_MESSAGE: ReadonlyArray<readonly [RegExp, TransportErrorKind]> = [
  [/premature close/i, TransportErrorKind.BODY_TRUNCATED],
  [/content-length mismatch|incomplete|truncat/i, TransportErrorKind.BODY_TRUNCATED],
  [
    /terminated|socket hang up|other side closed|closed prematurely/i,
    TransportErrorKind.CONNECTION_RESET,
  ],
  [/timed? ?out|deadline/i, TransportErrorKind.TIMEOUT],
  [/certificate|tls|ssl handshake/i, TransportErrorKind.TLS_FAILURE],
  [/getaddrinfo|dns/i, TransportErrorKind.DNS_FAILURE],
];

function matchKind(
  token: string | undefined,
  table: typeof KIND_BY_CODE,
): TransportErrorKind | null {
  if (!token) return null;
  for (const [pattern, kind] of table) {
    if (pattern.test(token)) return kind;
  }
  return null;
}

/**
 * Recognise a thrown error as a transport failure.
 *
 * `partialBody` is whatever bytes the caller had already read when the failure
 * happened. It is carried for diagnostics only — see
 * `TransportError.partialBody` for why it is never parsed. A timeout that
 * arrives *after* 900 bytes of a 1 kB response is still a timeout, still
 * `SYSTEM_ERROR`, and specifically **not** a `DATA_RESULT` with a short body:
 * the two are indistinguishable on the wire, and only one of them can cost the
 * provider their stake.
 */
export function classifyTransportError(
  error: unknown,
  partialBody?: string | null,
): TransportError {
  const chain = causeChain(error);

  for (const link of chain) {
    const code = stringField(link, 'code');
    const name = stringField(link, 'name');
    const kind = matchKind(code, KIND_BY_CODE) ?? matchKind(name, KIND_BY_CODE);
    if (kind) return build(kind, chain, partialBody);
  }

  for (const link of chain) {
    const kind = matchKind(stringField(link, 'message'), KIND_BY_MESSAGE);
    if (kind) return build(kind, chain, partialBody);
  }

  // Unrecognised, and still `SYSTEM_ERROR`. The default for anything the
  // classifier does not understand is the class with no penalty — an unknown
  // failure is not evidence of provider misbehaviour, it is evidence that this
  // recogniser needs another pattern.
  return build(TransportErrorKind.UNKNOWN, chain, partialBody);
}

function build(
  kind: TransportErrorKind,
  chain: readonly unknown[],
  partialBody?: string | null,
): TransportError {
  const detail = chain
    .map((link) => {
      const code = stringField(link, 'code');
      const message = stringField(link, 'message');
      return code ? `${code}: ${message ?? ''}`.trim() : message;
    })
    .filter((part): part is string => Boolean(part))
    .join(' ← ');

  return {
    kind,
    partialBody: partialBody ?? null,
    detail: detail || errorName(chain[0]),
  };
}

function errorName(value: unknown): string {
  return stringField(value, 'name') ?? 'UnknownError';
}
