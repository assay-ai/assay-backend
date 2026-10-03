import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { appConfig } from '@config/app.config';
import { observabilityConfig } from '@config/observability.config';
import { authConfig } from '@config/auth.config';
import { AlertingModule } from '@shared/alerting';
import { databaseConfig } from '@config/database.config';
import { redisConfig } from '@config/redis.config';
import { bullmqConfig } from '@config/bullmq.config';

// Infrastructure
import { DatabaseModule } from '@database/database.module';
import { RedisCacheModule } from '@shared/cache/redis-cache/redis-cache.module';
import { RedisAdapterModule } from '@shared/cache/redis-adapter/redis-adapter.module';

// WebSocket
import { WebSocketModule } from '@websocket/websocket.module';

// Controllers
import { HealthcheckController } from '@shared/controllers/healthcheck.controller';
import { NetworkModule } from '@shared/network/network.module';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig, bullmqConfig, observabilityConfig, authConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    AlertingModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => configService.get('bullmq'),
    }),
    // Infrastructure
    NetworkModule,
    DatabaseModule,
    RedisCacheModule,
    RedisAdapterModule,
    // WebSocket
    WebSocketModule,
  ],
  controllers: [HealthcheckController],
})
export class AppWebSocketModule {}
