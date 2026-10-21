import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { ServerOptions } from 'socket.io';
import type { Redis } from 'ioredis';
import { REDIS_ADAPTER_CLIENT } from '@shared/cache/redis-adapter/redis-adapter.provider';

/**
 * The socket.io server options with the API's CORS allow-list (BUG-SEC-03).
 *
 * `app.enableCors` only reaches Nest's HTTP routes; engine.io answers
 * `/socket.io/` itself, so the allow-list has to be in the server's own
 * `cors` option. It is the exact list `parseCorsAllowedOrigins` returns (which
 * refuses `*`), and it replaces any `cors` a gateway passes, so no gateway can
 * widen it: a listed origin is reflected with credentials, any other origin
 * gets no `Access-Control-Allow-*` header.
 */
export function socketIoServerOptions(
  options: Partial<ServerOptions> | undefined,
  allowedOrigins: readonly string[],
): Partial<ServerOptions> {
  return {
    ...(options ?? {}),
    cors: {
      origin: [...allowedOrigins],
      credentials: true,
      methods: ['GET', 'POST'],
    },
  };
}

/**
 * Redis IO Adapter for Socket.IO
 * Enables horizontal scaling by synchronizing events across multiple server instances
 * Reuses the Redis client from RedisAdapterModule
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;

  private readonly logger = new Logger(RedisIoAdapter.name);

  constructor(
    private readonly app: INestApplication,
    private readonly allowedOrigins: readonly string[],
  ) {
    super(app);
  }

  /**
   * Connect to Redis and create adapter
   * Must be called before starting the WebSocket server
   */
  async connectToRedis(): Promise<void> {
    // Get the Redis client from RedisAdapterModule
    const pubClient = this.app.get<Redis>(REDIS_ADAPTER_CLIENT);

    // Create duplicate client for subscription
    const subClient = pubClient.duplicate();

    // Log connection events
    subClient.on('connect', () => {
      this.logger.log('Redis sub client connected');
    });

    subClient.on('error', (err) => {
      this.logger.error('Redis sub client error:', err);
    });

    // Wait for sub client to be ready
    await new Promise((resolve) => {
      if (subClient.status === 'ready') {
        resolve(true);
      } else {
        subClient.on('ready', resolve);
      }
    });

    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log('Redis adapter created successfully');
  }

  /**
   * Create Socket.IO server with Redis adapter and the CORS allow-list
   */
  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(
      port,
      socketIoServerOptions(options, this.allowedOrigins) as ServerOptions,
    );
    server.adapter(this.adapterConstructor);

    this.logger.log('Socket.IO server created with Redis adapter');
    return server;
  }
}
