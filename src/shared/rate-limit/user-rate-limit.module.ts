import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { parseUserRateLimitsEnabled } from './user-rate-limit.config';
import { USER_RATE_LIMITS_ENABLED, UserRateLimitInterceptor } from './user-rate-limit.interceptor';

/**
 * Registers {@link UserRateLimitInterceptor} for every route of the app that
 * imports this — `AppApiModule` only. The MCP app has limiters of its own.
 */
@Module({
  providers: [
    {
      provide: USER_RATE_LIMITS_ENABLED,
      useFactory: (config: ConfigService) =>
        parseUserRateLimitsEnabled(config.get<string>('API_USER_RATE_LIMITS_ENABLED')),
      inject: [ConfigService],
    },
    // One instance, reachable by its class (a test sets its clock) and
    // registered as the global interceptor.
    UserRateLimitInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: UserRateLimitInterceptor },
  ],
  exports: [UserRateLimitInterceptor],
})
export class UserRateLimitModule {}
