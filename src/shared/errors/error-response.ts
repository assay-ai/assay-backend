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
