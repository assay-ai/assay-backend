import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { RAW_RESPONSE_KEY } from '@shared/decorators/raw-response.decorator';

export interface Response<T> {
  data: T;
  statusCode: number;
  message: string;
}

/**
 * Wraps every successful body in the platform's `{ data, statusCode, message }`
 * envelope — except handlers marked `@RawResponse()`, whose body format is
 * specified by somebody else (Prometheus text, an HTML page). See that
 * decorator for why the exemption is a decorator rather than a `Content-Type`
 * check: a route can set `text/html` and still be handed JSON, and that is
 * exactly the defect this exists to make impossible.
 *
 * `reflector` is optional so the four existing `new TransformInterceptor()`
 * call sites keep working; without it nothing is exempt, which is the
 * original behaviour.
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, Response<T> | T> {
  constructor(private readonly reflector?: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<Response<T> | T> {
    const raw = this.reflector?.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (raw) return next.handle();

    return next.handle().pipe(
      map((data) => ({
        data,
        statusCode: context.switchToHttp().getResponse().statusCode,
        message: 'Success',
      })),
    );
  }
}
