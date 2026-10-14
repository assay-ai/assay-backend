import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import {
  ACCOUNT_BLOCKLIST_CONFIG,
  ACCOUNT_BLOCKLIST_REDIS,
  ACCOUNT_BLOCKLIST_SUBSCRIBER,
  AccountBlocklistConfig,
  AccountBlocklistService,
  DEFAULT_ACCOUNT_BLOCKLIST_CONFIG,
} from './services/account-blocklist.service';

/**
 * Its own pair of connections: a subscribed ioredis client can issue nothing
 * but (un)subscribe, so the publisher cannot share it, and sharing the cache
 * client would put a pub/sub listener on a connection other code reconfigures.
 */
const blocklistRedis = (config: ConfigService): Redis =>
  new Redis(config.get<string>('redis.url') as string, {
    password: config.get<string>('redis.password') || undefined,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });

/**
 * The in-memory account blocklist, for every module that enforces it.
 *
 * Imported by each module that has an enforcement point rather than made
 * `@Global`, so a module that checks the blocklist says so in its imports. Nest
 * builds one instance however many modules import it, so every enforcement
 * point in a process reads the same copy.
 */
@Module({
  providers: [
    { provide: ACCOUNT_BLOCKLIST_REDIS, inject: [ConfigService], useFactory: blocklistRedis },
    { provide: ACCOUNT_BLOCKLIST_SUBSCRIBER, inject: [ConfigService], useFactory: blocklistRedis },
    {
      provide: ACCOUNT_BLOCKLIST_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AccountBlocklistConfig => ({
        channel:
          config.get<string>('ACCOUNT_BLOCKLIST_CHANNEL') ??
          DEFAULT_ACCOUNT_BLOCKLIST_CONFIG.channel,
        pollIntervalMs: Number(
          config.get<string>('ACCOUNT_BLOCKLIST_POLL_MS') ??
            DEFAULT_ACCOUNT_BLOCKLIST_CONFIG.pollIntervalMs,
        ),
      }),
    },
    AccountBlocklistService,
  ],
  exports: [AccountBlocklistService],
})
export class BlocklistModule {}
