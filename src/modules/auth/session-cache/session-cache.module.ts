import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { SessionCache } from './session-cache';
import {
  SESSION_CACHE,
  SESSION_EVICTIONS_PUBLISHER,
  SESSION_EVICTIONS_SUBSCRIBER,
  SessionEvictions,
} from './session-evictions.service';

/**
 * Its own pair of connections, as the blocklist has: a subscribed ioredis
 * client can issue nothing but (un)subscribe.
 */
const evictionsRedis = (config: ConfigService): Redis =>
  new Redis(config.get<string>('redis.url') as string, {
    password: config.get<string>('redis.password') || undefined,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });

/**
 * The resolved-session cache of this process, and its cross-process
 * evictions.
 *
 * Global so a module that writes something a session depends on (a
 * revocation, an access epoch, a delegate) can inject `SessionEvictions`
 * without importing the auth module; those injections are `@Optional`, since
 * a process with no session cache has nothing of its own to evict and still
 * publishes nothing. Imported by `AuthModule`.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    { provide: SESSION_CACHE, useFactory: () => new SessionCache() },
    { provide: SESSION_EVICTIONS_PUBLISHER, inject: [ConfigService], useFactory: evictionsRedis },
    { provide: SESSION_EVICTIONS_SUBSCRIBER, inject: [ConfigService], useFactory: evictionsRedis },
    SessionEvictions,
  ],
  exports: [SESSION_CACHE, SessionEvictions],
})
export class SessionCacheModule {}
