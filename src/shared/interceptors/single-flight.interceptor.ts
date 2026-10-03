import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { from, Observable } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';
import { createHash } from 'crypto';
import { SINGLEFLIGHT_META, SingleFlightOptions } from '@shared/decorators/single-flight.decorator';
import { SingleFlightService } from '@shared/services/single-flight.service';

@Injectable()
export class SingleFlightInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly singleFlight: SingleFlightService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const handler = context.getHandler();
    const opts = this.reflector.get<SingleFlightOptions>(SINGLEFLIGHT_META, handler);

    // Not annotated → normal execution
    if (!opts) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest();

    const key = opts.keyFactory?.(req) ?? this.getKey(req);

    return from(
      this.singleFlight.execute({
        key,
        fn: async () => {
          return await firstValueFrom(next.handle());
        },
        options: opts,
      }),
    ).pipe(
      catchError((error) => {
        throw error;
      }),
    );
  }

  private getKey(req: Request): string {
    const pathname = req.path || req.url.split('?')[0]; // include params
    const userId = req.headers['x-user-id'] as string | undefined;
    const sortedQuery =
      req.query && Object.keys(req.query).length > 0
        ? Object.keys(req.query)
            .sort()
            .map((key) => {
              const value = req.query[key];
              const serialized =
                Array.isArray(value) || typeof value === 'object'
                  ? JSON.stringify(value)
                  : String(value);
              return `${key}=${serialized}`;
            })
            .join('&')
        : '';

    const keyString = [pathname, sortedQuery, userId].filter(Boolean).join('|');
    return createHash('sha256').update(keyString).digest('hex');
  }
}
