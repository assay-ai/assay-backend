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
import { redactOAuthUrl } from '@shared/observability';
import {
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

    const { code, message, statusCode, context } = this.describe(exception);
    // The path is logged and echoed with any consent request id and OAuth
    // secret replaced (R-OA-27). The request body is never read here.
    const path = redactOAuthUrl(request.originalUrl ?? request.url);
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

      return {
        code: httpErrorCodeForStatus(statusCode),
        message: messageFromHttpPayload(payload, exception.message),
        statusCode,
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
