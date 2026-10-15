import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseCorsAllowedOrigins } from '@config/app.config';
import { applyHttpSecurity } from '@shared/security/security-headers';
import { AppWebSocketModule } from './app.module';
import { RedisIoAdapter } from 'src/websocket/adapters/redis-io.adapter';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { TransformInterceptor } from '@shared/interceptors/transform.interceptor';
import { StructuredLogger } from '@shared/observability';
import { LoggingInterceptor } from '@shared/interceptors/logging.interceptor';

async function bootstrapWebSocket() {
  const app = await NestFactory.create(AppWebSocketModule, {
    logger: new StructuredLogger(),
  });
  const configService = app.get(ConfigService);

  // Get config
  const port = configService.get<number>('app.websocket.port');

  // Setup Redis adapter for horizontal scaling
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  applyHttpSecurity(app);

  // CORS for WebSocket: the same allowlist as the API (`CORS_ALLOWED_ORIGINS`).
  app.enableCors({
    origin: parseCorsAllowedOrigins(),
    credentials: true,
  });

  // Global filter — the same single shape the API serves.
  app.useGlobalFilters(new AllExceptionsFilter());

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Global interceptors
  app.useGlobalInterceptors(new LoggingInterceptor(), new TransformInterceptor());

  await app.listen(port);

  console.log(`
  🔌 [WEBSOCKET SERVER] WebSocket server is running on: http://localhost:${port}
  📡 Namespaces:
     - /markets (Market data updates - provider-agnostic)
     - /events (Event status updates - provider-agnostic)
  `);
}

export { bootstrapWebSocket };
