import { Module } from '@nestjs/common';

import { ChainsModule } from '@modules/chains/chains.module';
import { RedisCacheModule } from '@shared/cache/redis-cache/redis-cache.module';

import { ProtocolAnalyticsController } from './controllers/protocol-analytics.controller';
import { ProtocolAnalyticsRepository } from '@database/postgres/repositories/protocol-analytics.repository';
import { ProtocolAnalyticsService } from './services/protocol-analytics.service';

@Module({
  imports: [ChainsModule, RedisCacheModule],
  controllers: [ProtocolAnalyticsController],
  providers: [ProtocolAnalyticsRepository, ProtocolAnalyticsService],
})
export class ProtocolAnalyticsApiModule {}
