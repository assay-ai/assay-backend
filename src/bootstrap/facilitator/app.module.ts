import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { appConfig } from '@config/app.config';
import { observabilityConfig } from '@config/observability.config';
import { authConfig } from '@config/auth.config';
import { AlertingModule } from '@shared/alerting';
import { redisConfig } from '@config/redis.config';

// Infrastructure — Redis only. No `DatabaseModule`: the facilitator has no
// entities and no organization scope (`docs/architecture.md` §Multi-Organization
// Scoping) — it verifies and signs transactions, and remembers nothing beyond
// the 120s duplicate-settlement cache. No `BullModule`/`WebSocketEmitterModule`
// either — it does no background work and emits no realtime events.
import { RedisCacheModule } from '@shared/cache/redis-cache/redis-cache.module';

// The facilitator's own domain module — never `ChainsModule`, `PaymentModule`
// or `LedgerModule`. See `facilitator.module.ts` for why.
import { FacilitatorModule } from '@modules/chains/facilitator/facilitator.module';

import { HealthcheckController } from '@shared/controllers/healthcheck.controller';
import { NetworkModule } from '@shared/network/network.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, redisConfig, observabilityConfig, authConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    AlertingModule,
    NetworkModule,
    RedisCacheModule,
    FacilitatorModule,
  ],
  controllers: [HealthcheckController],
})
export class AppFacilitatorModule {}
