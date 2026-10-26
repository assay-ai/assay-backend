/**
 * The ONE error shape for the whole stack.
 *
 * Every failure — a domain `AppError`, a framework `HttpException`, a 404 for a
 * route that does not exist, an unhandled `TypeError` — leaves the API in this
 * shape and no other. A client that can parse one error can parse all of them.
 *
 * ```json
 * {
 *   "success": false,
 *   "error": {
 *     "code": "PAYMENT_INTENT_NOT_FOUND",
 *     "message": "Payment intent not found with id: abc-123",
 *     "statusCode": 404,
 *     "path": "/api/v1/payments/abc-123",
 *     "timestamp": "2026-08-12T10:00:00.000Z"
 *   }
 * }
 * ```
 *
 * There are no optional members. Validation failures fold their per-field
 * messages into `message` rather than adding a branch — one shape that is
 * sometimes richer is two shapes.
 */
export interface ErrorResponse {
  success: false;
  error: {
    /** Domain code (`PAYMENT_*`, `LEDGER_*`, …) or an HTTP-level code. */
    code: string;
    message: string;
    statusCode: number;
    path: string;
    /** ISO-8601, UTC. */
    timestamp: string;
    /**
     * Structured detail, only for an error whose definition declares it safe
     * (`ErrorDefinition.publicContext`) — e.g. `SLASH_CHAIN_BATCH_REFUSED`'s
     * `refusals[]`. Absent otherwise.
     */
    context?: Record<string, unknown>;
  };
}

/**
 * Codes for failures raised by the framework rather than by a domain: a missing
 * route, a rejected payload, an unhandled exception. Domain failures never use
 * these — they carry their own prefixed code from the module's catalog.
 */
export enum HttpErrorCode {
  BAD_REQUEST = 'BAD_REQUEST',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED',
  CONFLICT = 'CONFLICT',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE',
  UNPROCESSABLE_ENTITY = 'UNPROCESSABLE_ENTITY',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
  BAD_GATEWAY = 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  GATEWAY_TIMEOUT = 'GATEWAY_TIMEOUT',
}

const STATUS_TO_CODE: Record<number, HttpErrorCode> = {
  400: HttpErrorCode.BAD_REQUEST,
  401: HttpErrorCode.UNAUTHORIZED,
  403: HttpErrorCode.FORBIDDEN,
  404: HttpErrorCode.NOT_FOUND,
  405: HttpErrorCode.METHOD_NOT_ALLOWED,
  409: HttpErrorCode.CONFLICT,
  413: HttpErrorCode.PAYLOAD_TOO_LARGE,
  415: HttpErrorCode.UNSUPPORTED_MEDIA_TYPE,
  422: HttpErrorCode.UNPROCESSABLE_ENTITY,
  429: HttpErrorCode.TOO_MANY_REQUESTS,
  500: HttpErrorCode.INTERNAL_SERVER_ERROR,
  501: HttpErrorCode.NOT_IMPLEMENTED,
  502: HttpErrorCode.BAD_GATEWAY,
  503: HttpErrorCode.SERVICE_UNAVAILABLE,
  504: HttpErrorCode.GATEWAY_TIMEOUT,
};

export function httpErrorCodeForStatus(statusCode: number): HttpErrorCode {
  return (
    STATUS_TO_CODE[statusCode] ??
    (statusCode >= 500 ? HttpErrorCode.INTERNAL_SERVER_ERROR : HttpErrorCode.BAD_REQUEST)
  );
}

/**
 * The status this process may answer with: `502` and `504` become `503`; every
 * other status is unchanged.
 *
 * Cloudflare, in front of every public host, replaces an origin `502` or `504`
 * with its own branded page. That page carries no CORS headers, so a browser on
 * the web app sees "Failed to fetch" and never the `ErrorResponse` body
 * (verified on production: a `502` thrown by `POST /deposits/:id/broadcast`).
 * The setting that passes them through is Enterprise-only. So no error this
 * process wants a client to read may leave as a `502`/`504`: the domain
 * errors declare `503` themselves, and this is the backstop for anything that
 * still carries one — a Nest `BadGatewayException`, a library's
 * `HttpException`. The error `code` is kept, so a client still knows which
 * failure it was.
 */
export function edgeSafeStatus(statusCode: number): number {
  return statusCode === 502 || statusCode === 504 ? 503 : statusCode;
}
