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

// WebSocket Emitter (for publishing events from background jobs)
import { WebSocketEmitterModule } from '@websocket/websocket-emitter.module';

// Starter reference modules — see src/modules/_examples/README.md
import { ExamplesWorkerModule } from '@modules/_examples/examples-worker.module';
import { areExamplesEnabled } from '@modules/_examples/examples.flag';

// Verification worker — judges a `DATA_RESULT` off the request path
// and settles the intent the MCP process left in `VERIFYING`.
import { VerificationWorkerModule } from '@modules/verification/verification-worker.module';
import { NotificationWorkerModule } from '@modules/notification/notification-worker.module';

// Verifier signing key — imported HERE and in no other bootstrap, because
// importing it is what puts the key in a process's address space. The trust
// boundaries put the verifier signer on the far side of a line from `api` and
// `mcp`; the worker is where verdicts are produced, so it is the one process
// with a reason to sign. The end state is its own SERVICE_TYPE, as the
// facilitator already has for the fee-payer key — not done yet.
import { VerifierSigningModule } from '@modules/verification/signing/verifier-signing.module';

// Controllers
import { HealthcheckController } from '@shared/controllers/healthcheck.controller';
import { NetworkModule } from '@shared/network/network.module';

/**
 * Worker bootstrap module — replaces the former RabbitMQ consumers service.
 *
 * Imports the *-worker.module.ts of every feature whose background work
 * (BullMQ processors) must run in the worker process. Never imports the
 * *-api.module.ts variants — those hold HTTP controllers that have no place
 * in a headless worker.
 *
 * See `docs/adr/0001-bullmq-as-wakeup-mechanism.md` for why each feature is
 * split into shared / api / worker sub-modules.
 */
@Module({
  imports: [
    // ConfigModule.forRoot loads .env files synchronously into process.env on
    // this call — keep it first so the env-gated imports below see the
    // correct values.
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
    WebSocketEmitterModule,
    VerificationWorkerModule,
    // Drains `notification.deliver`. A `@Processor()` starts
    // a Worker on instantiation, so it is registered here and nowhere else.
    NotificationWorkerModule,
    VerifierSigningModule,
    // Starter reference modules — off by default in production
    ...(areExamplesEnabled() ? [ExamplesWorkerModule] : []),
  ],
  controllers: [HealthcheckController],
})
export class AppWorkerModule {}
