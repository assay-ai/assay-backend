import type { Provider } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

export const REDIS_ADAPTER_CLIENT = 'REDIS_ADAPTER_CLIENT';

export const RedisAdapterProvider: Provider = {
  provide: REDIS_ADAPTER_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): Redis => {
    const logger = new Logger('RedisAdapter');

    const url = configService.get<string>('redis.url');
    const password = configService.get<string>('redis.password');

    const client = new Redis(url, {
      db: 0,
      password: password || undefined,
      enableReadyCheck: true,
      connectTimeout: 10 * 1000, // 10 seconds
      maxRetriesPerRequest: null, // No limit for Socket.IO adapter
      retryStrategy: (times) => {
        logger.warn(`Retrying connection attempt ${times}`);
        return Math.min(times * 100, 5000); // Max 5 seconds
      },
    });

    client.on('connect', () => {
      logger.log('Connecting to Redis adapter...');
    });

    client.on('ready', () => {
      logger.log('Connected to Redis adapter successfully');
    });

    client.on('error', (err) => {
      logger.error('Redis adapter error', err);
    });

    client.on('close', () => {
      logger.warn('Redis adapter connection closed');
    });

    client.on('reconnecting', () => {
      logger.log('Reconnecting to Redis adapter...');
    });

    return client;
  },
};

export const REDIS_ADAPTER_SUB_CLIENT = 'REDIS_ADAPTER_SUB_CLIENT';
export const REDIS_ADAPTER_PUB_CLIENT = 'REDIS_ADAPTER_PUB_CLIENT';
export const REDIS_COMMANDER_CLIENT = 'REDIS_COMMANDER_CLIENT';

export const RedisAdapterPubProvider: Provider = {
  provide: REDIS_ADAPTER_PUB_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): Redis => {
    const logger = new Logger('RedisAdapterPub');

    const url = configService.get<string>('redis.url');
    const password = configService.get<string>('redis.password');

    const client = new Redis(url, {
      db: 0,
      password: password || undefined,
      enableReadyCheck: true,
      connectTimeout: 10 * 1000, // 10 seconds
      maxRetriesPerRequest: 0,
      retryStrategy: (times) => {
        logger.warn(`Retrying connection attempt ${times}`);
        return Math.min(times * 100, 5000); // Max 5 seconds
      },
    });

    client.on('connect', () => {
      logger.log('Connecting to Redis pub client...');
    });

    client.on('ready', () => {
      logger.log('Connected to Redis pub client successfully');
    });

    client.on('error', (err) => {
      logger.error('Redis pub client error', err);
    });

    client.on('close', () => {
      logger.warn('Redis pub client connection closed');
    });

    client.on('reconnecting', () => {
      logger.log('Reconnecting to Redis pub client...');
    });

    return client;
  },
};

export const RedisAdapterSubProvider: Provider = {
  provide: REDIS_ADAPTER_SUB_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): Redis => {
    const logger = new Logger('RedisAdapterSub');

    const url = configService.get<string>('redis.url');
    const password = configService.get<string>('redis.password');

    const client = new Redis(url, {
      db: 0,
      password: password || undefined,
      enableReadyCheck: true,
      connectTimeout: 10 * 1000, // 10 seconds
      maxRetriesPerRequest: 0,
      retryStrategy: (times) => {
        logger.warn(`Retrying connection attempt ${times}`);
        return Math.min(times * 100, 5000); // Max 5 seconds
      },
    });

    client.on('connect', () => {
      logger.log('Connecting to Redis sub client...');
    });

    client.on('ready', () => {
      logger.log('Connected to Redis sub client successfully');
    });

    client.on('error', (err) => {
      logger.error('Redis sub client error', err);
    });

    client.on('close', () => {
      logger.warn('Redis sub client connection closed');
    });

    client.on('reconnecting', () => {
      logger.log('Reconnecting to Redis sub client...');
    });

    return client;
  },
};

export const RedisCommanderProvider: Provider = {
  provide: REDIS_COMMANDER_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): Redis => {
    const logger = new Logger('RedisCommander');

    const url = configService.get<string>('redis.url');
    const password = configService.get<string>('redis.password');

    const client = new Redis(url, {
      db: 0,
      password: password || undefined,
    });

    client.on('connect', () => {
      logger.log('Connecting to Redis commander client...');
    });

    client.on('ready', () => {
      logger.log('Connected to Redis commander client successfully');
    });

    return client;
  },
};
