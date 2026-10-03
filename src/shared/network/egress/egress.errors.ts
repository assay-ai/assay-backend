import { AppError } from '@shared/errors/app-errors';
import { AssertDomainErrorCodes } from '@shared/errors/error-catalog';
import { BlockedAddressReason } from './ip-rules';

/**
 * `EGRESS_*` — every way an outbound call can be refused or cut short.
 *
 * Written as one parameterised class rather than a `createDomainErrorFactory`
 * catalog because these errors carry structure a message string cannot: the
 * {@link EgressFailureKind} the router branches on, the address we refused, and
 * the bytes that had arrived when we gave up. The prefix rule the catalog
 * enforces at runtime is enforced here at compile time by
 * {@link EgressErrorCodesArePrefixed}.
 */
export enum EgressFailureKind {
  /** Not a URL, or a URL with no host. */
  URL_INVALID = 'URL_INVALID',
  /** Not `http:` or `https:` — `file:`, `gopher:`, `ftp:`, `data:`. */
  SCHEME_NOT_ALLOWED = 'SCHEME_NOT_ALLOWED',
  /** The hostname did not resolve, or resolved to nothing. */
  DNS_FAILED = 'DNS_FAILED',
  /** It resolved, and the address is one we refuse to connect to. */
  BLOCKED_ADDRESS = 'BLOCKED_ADDRESS',
  /** A `3xx` whose `Location` is missing or unparseable. */
  REDIRECT_INVALID = 'REDIRECT_INVALID',
  /** More `3xx` hops than the policy allows. */
  TOO_MANY_REDIRECTS = 'TOO_MANY_REDIRECTS',
  /** The body passed `maxResponseBytes`, by declaration or by arrival. */
  RESPONSE_TOO_LARGE = 'RESPONSE_TOO_LARGE',
  /** A per-hop or total deadline expired. This is the slow-drip case. */
  TIMEOUT = 'TIMEOUT',
  /** The socket failed: refused, reset, TLS rejected. */
  CONNECTION_FAILED = 'CONNECTION_FAILED',
}

export type EgressErrorCode = `EGRESS_${EgressFailureKind}`;

/** Fails `yarn build` if a kind is ever added that would not carry the prefix. */
export type EgressErrorCodesArePrefixed = AssertDomainErrorCodes<'EGRESS', EgressErrorCode>;

/**
 * `4xx` for "this URL is not acceptable, and re-sending it will not help" —
 * these are the ones a registration endpoint (connectivity check) returns to the provider
 * who typed the URL. `502` for "we tried and the far end misbehaved".
 */
const STATUS_BY_KIND: Readonly<Record<EgressFailureKind, number>> = Object.freeze({
  [EgressFailureKind.URL_INVALID]: 400,
  [EgressFailureKind.SCHEME_NOT_ALLOWED]: 400,
  [EgressFailureKind.BLOCKED_ADDRESS]: 403,
  [EgressFailureKind.DNS_FAILED]: 502,
  [EgressFailureKind.REDIRECT_INVALID]: 502,
  [EgressFailureKind.TOO_MANY_REDIRECTS]: 502,
  [EgressFailureKind.RESPONSE_TOO_LARGE]: 502,
  [EgressFailureKind.TIMEOUT]: 504,
  [EgressFailureKind.CONNECTION_FAILED]: 502,
});

export interface EgressErrorContext {
  /** The URL of the hop that failed — not necessarily the one the caller passed. */
  readonly url?: string;
  /** The address we resolved to, when we got that far. */
  readonly address?: string;
  /** Why the address was refused, when that is what happened. */
  readonly addressReason?: BlockedAddressReason;
  /**
   * Bytes that arrived before we gave up.
   *
   * Carried for the same reason `TransportError.partialBody` is: a truncated
   * body is byte-identical to a short one, so these bytes are evidence for a
   * human and must never be parsed as a result. See
   * `src/modules/tool/domain/classification/classification.types.ts`.
   */
  readonly partialBody?: string | null;
  /** The underlying error, when there was one. */
  readonly cause?: unknown;
}

export class EgressError extends AppError {
  readonly kind: EgressFailureKind;

  /**
   * The error code, also exposed as `code`.
   *
   * `classifyTransportError` walks a thrown error's cause chain reading `code`
   * and `name` — that is the contract Node's own errors follow (`ECONNRESET`,
   * `UND_ERR_BODY_TIMEOUT`), and following it here is what lets an egress
   * failure classify as `SYSTEM_ERROR` with the right
   * `TransportErrorKind` instead of falling through to `UNKNOWN`.
   */
  readonly code: EgressErrorCode;

  readonly url?: string;
  readonly address?: string;
  readonly addressReason?: BlockedAddressReason;
  readonly partialBody?: string | null;

  /**
   * Declared here rather than inherited: `Error.cause` is an ES2022 addition
   * and this project targets ES2021, so the base type does not have it. It is
   * the field `classifyTransportError` walks, so it has to exist by name.
   */
  readonly cause?: unknown;

  constructor(kind: EgressFailureKind, detail: string, context: EgressErrorContext = {}) {
    const code: EgressErrorCode = `EGRESS_${kind}`;
    super({
      code,
      statusCode: STATUS_BY_KIND[kind],
      message: () =>
        `Outbound request refused (${kind})${context.url ? ` for ${context.url}` : ''}: ${detail}`,
    });

    this.kind = kind;
    this.code = code;
    this.url = context.url;
    this.address = context.address;
    this.addressReason = context.addressReason;
    this.partialBody = context.partialBody ?? null;
    if (context.cause !== undefined) {
      this.cause = context.cause;
    }
  }
}

export function isEgressError(value: unknown): value is EgressError {
  return value instanceof EgressError;
}
