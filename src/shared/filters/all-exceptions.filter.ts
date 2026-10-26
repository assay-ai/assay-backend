import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppError } from '@shared/errors/app-errors';
import { redactOAuthText, redactOAuthUrl } from '@shared/observability';
import {
  edgeSafeStatus,
  ErrorResponse,
  HttpErrorCode,
  httpErrorCodeForStatus,
} from '@shared/errors/error-response';

interface DescribedError {
  code: string;
  message: string;
  statusCode: number;
  context?: Record<string, unknown>;
}

/**
 * The ONLY exception filter in the API process.
 *
 * The starter shipped three — a 500 monitor that re-threw, an `AppError`
 * formatter and an `HttpException` formatter — and the last two disagreed about
 * the body. `AppError` produced `{ success, error: { code, … } }` while every
 * `HttpException`, including a plain 404, produced
 * `{ statusCode, timestamp, path, message }`. A caller therefore had to parse
 * two shapes and guess which one it had received. This filter catches
 * everything and emits {@link ErrorResponse}, once, for every failure.
 *
 * Registered as the single global filter in `bootstrap/api/main.ts`. Do not add
 * a second: `@Catch()` here already covers every exception, and a filter
 * registered after it takes precedence for its own type, which is exactly how
 * the two-shape problem came back.
 */
@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      // No response to serialise into — let the transport handle it.
      this.logger.error(`Non-HTTP exception: ${describeMessage(exception)}`, stackOf(exception));
      throw exception;
    }

    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const described = this.describe(exception);
    const { code, context } = described;
    // Never a `502`/`504`: the edge would replace the body (`edgeSafeStatus`).
    const statusCode = edgeSafeStatus(described.statusCode);
    // The path is logged and echoed with any consent request id and OAuth
    // secret replaced (R-OA-27). The request body is never read here.
    const path = redactOAuthUrl(request.originalUrl ?? request.url);
    // So is the message: Nest builds some from the request itself (see
    // `safeMessage`).
    const message = safeMessage(described.message, request.method, path);
    const line = `[${statusCode}] ${code} - ${message} | ${request.method} ${path}`;

    // 5xx is our bug and must reach whoever is on call; 4xx is the caller's
    // and would only bury the former in noise.
    if (statusCode >= 500) {
      this.logger.error(line, stackOf(exception));
    } else {
      this.logger.debug(line);
    }

    if (response.headersSent) {
      return;
    }

    const body: ErrorResponse = {
      success: false,
      error: {
        code,
        message,
        statusCode,
        path,
        timestamp: new Date().toISOString(),
        // Only what the error's definition declares safe (`publicContext`).
        ...(context ? { context } : {}),
      },
    };

    response.status(statusCode).json(body);
  }

  private describe(exception: unknown): DescribedError {
    if (exception instanceof AppError) {
      return {
        code: exception.errorCode,
        message: exception.message,
        statusCode: exception.statusCode,
        ...(exception.publicContext ? { context: { ...exception.publicContext } } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();

      // class-validator reports one message per failed constraint. They are
      // folded into a single string so the shape never grows a second branch.
      if (isValidationPayload(payload)) {
        return {
          code: HttpErrorCode.VALIDATION_FAILED,
          message: payload.message.join('; '),
          statusCode,
        };
      }

      const message = messageFromHttpPayload(payload, exception.message);
      // Nest's `Parse*Pipe` refusals (`ParseUUIDPipe` on a path param) are a
      // validation failure like any DTO's, so they get the same code.
      if (statusCode === 400 && PARSE_PIPE_MESSAGE.test(message)) {
        return { code: HttpErrorCode.VALIDATION_FAILED, message, statusCode };
      }

      return {
        code: httpErrorCodeForStatus(statusCode),
        message,
        statusCode,
      };
    }

    // body-parser's own refusals (body too large, bad charset, aborted) are
    // `http-errors`, not HttpException: a client-side 4xx whose message is
    // marked safe to send (`expose`). Without this they count as our 500s.
    const clientError = exposedClientError(exception);
    if (clientError) {
      return {
        code: httpErrorCodeForStatus(clientError.status),
        message: clientError.status === 413 ? PAYLOAD_TOO_LARGE_MESSAGE : clientError.message,
        statusCode: clientError.status,
      };
    }

    return {
      code: HttpErrorCode.INTERNAL_SERVER_ERROR,
      // An unhandled exception's message is written for us, not for the caller,
      // and may name internals. Outside development the status is all they get.
      message:
        process.env.NODE_ENV === 'development'
          ? describeMessage(exception)
          : 'Internal server error',
      statusCode: 500,
    };
  }
}

/**
 * V8's `JSON.parse` messages, which quote up to ~10 characters of the input.
 * Nest turns a body-parser `SyntaxError` into `BadRequestException(err.message)`
 * (`RoutesResolver.mapExternalException`), so this is a piece of the body.
 */
const JSON_PARSE_MESSAGE = /is not valid JSON|JSON at position \d+|end of JSON input|after JSON/;

/**
 * The message of Nest's built-in `Parse*Pipe`s, e.g. `Validation failed (uuid
 * is expected)` from `ParseUUIDPipe`.
 */
const PARSE_PIPE_MESSAGE = /^Validation failed \(.+ is expected\)$/;

/** The fixed text for a body the JSON parser refused. */
export const MALFORMED_BODY_MESSAGE = 'Malformed request body';

/**
 * The fixed text for a body over the parser's limit (413 `PAYLOAD_TOO_LARGE`,
 * on the API and the MCP host alike). body-parser's own text is jargon.
 */
export const PAYLOAD_TOO_LARGE_MESSAGE = 'The request body is too large.';

/**
 * Express's `URIError` for a path param it cannot decode, which Nest turns
 * into `BadRequestException(err.message)`. It quotes the raw param — a rid on
 * the consent routes — so its text is replaced outright.
 */
const PARAM_DECODE_MESSAGE = /^Failed to decode param /;

/** The fixed text for a path param that could not be decoded. */
export const MALFORMED_PATH_MESSAGE = 'Malformed request path';

/**
 * The message as it may be logged and echoed (R-OA-27):
 * - a JSON parse failure is replaced outright, since it quotes the body;
 * - so is a param-decode failure, since it quotes the param;
 * - Nest's route-not-found `Cannot {METHOD} {originalUrl}` is rebuilt from
 *   the already-redacted path;
 * - anything else goes through the same rid, query and token redaction as
 *   the path.
 */
function safeMessage(message: string, method: string, path: string): string {
  if (JSON_PARSE_MESSAGE.test(message)) return MALFORMED_BODY_MESSAGE;
  if (PARAM_DECODE_MESSAGE.test(message)) return MALFORMED_PATH_MESSAGE;
  if (message.startsWith(`Cannot ${method} `)) return `Cannot ${method} ${path}`;
  return redactOAuthText(message);
}

function isValidationPayload(payload: unknown): payload is { message: string[] } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    Array.isArray((payload as { message?: unknown }).message)
  );
}

function messageFromHttpPayload(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') {
    return payload;
  }

  const message = (payload as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : fallback;
}

function describeMessage(exception: unknown): string {
  if (exception instanceof Error) {
    return exception.message;
  }
  return typeof exception === 'string' ? exception : 'Unknown error';
}

function stackOf(exception: unknown): string | undefined {
  return exception instanceof Error ? exception.stack : undefined;
}

/** An `http-errors` 4xx whose message its creator marked safe to send. */
function exposedClientError(exception: unknown): { status: number; message: string } | null {
  if (typeof exception !== 'object' || exception === null) return null;
  const { status, expose, message } = exception as {
    status?: unknown;
    expose?: unknown;
    message?: unknown;
  };
  if (expose !== true || typeof status !== 'number' || status < 400 || status > 499) return null;
  return { status, message: typeof message === 'string' ? message : 'Bad request' };
}
