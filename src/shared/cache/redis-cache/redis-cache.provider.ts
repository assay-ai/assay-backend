import type { Provider } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

export const REDIS_CACHE_CLIENT = 'REDIS_CACHE_CLIENT';

export const RedisCacheProvider: Provider = {
  provide: REDIS_CACHE_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): Redis => {
    const logger = new Logger('RedisCache');

    const url = configService.get<string>('redis.url');
    const password = configService.get<string>('redis.password');

    const client = new Redis(url, {
      db: 0,
      password: password || undefined,
      enableReadyCheck: true,
      connectTimeout: 10 * 1000, // 10 seconds
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => {
        logger.warn(`Retrying connection attempt ${times}`);
        return Math.min(times * 100, 5000); // Max 5 seconds
      },
    });

    client.on('connect', () => {
      logger.log('Connecting to Redis cache...');
    });

    client.on('ready', () => {
      logger.log('Connected to Redis cache successfully');
    });

    client.on('error', (err) => {
      logger.error('Redis cache error', err);
    });

    client.on('close', () => {
      logger.warn('Redis cache connection closed');
    });

    client.on('reconnecting', () => {
      logger.log('Reconnecting to Redis cache...');
    });

    return client;
  },
};
