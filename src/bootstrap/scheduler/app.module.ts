import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { appConfig } from '@config/app.config';
import { observabilityConfig } from '@config/observability.config';
import { authConfig } from '@config/auth.config';
import { databaseConfig } from '@config/database.config';
import { redisConfig } from '@config/redis.config';
import { bullmqConfig } from '@config/bullmq.config';

// Infrastructure
import { DatabaseModule } from '@database/database.module';
import { AlertingModule } from '@shared/alerting';
import { RedisCacheModule } from '@shared/cache/redis-cache/redis-cache.module';

// WebSocket Emitter (for publishing events from cron jobs)
import { WebSocketEmitterModule } from '@websocket/websocket-emitter.module';

// Domain Modules
import { DisputeSchedulerModule } from '@modules/dispute/dispute-scheduler.module';
import { PaymentSchedulerModule } from '@modules/payment/payment-scheduler.module';
import {
  ProviderBindingStatsSchedulerModule,
  ProviderSlaWindowSweepSchedulerModule,
  ProviderStakeMonitorSchedulerModule,
} from '@modules/provider/provider-scheduler.module';
import { SettlementSchedulerModule } from '@modules/settlement/settlement-scheduler.module';
import { SlashSchedulerModule } from '@modules/slash/slash-scheduler.module';
import { VerifierSigningModule } from '@modules/verification/signing/verifier-signing.module';
import { VerificationSchedulerModule } from '@modules/verification/verification-scheduler.module';
import { AccountSchedulerModule } from '@modules/account/account-scheduler.module';
import { FreeTierSchedulerModule } from '@modules/free-tier/free-tier-scheduler.module';
import { EvmSchedulerModule } from '@modules/chains/evm/evm-scheduler.module';
import { ToolsetSchedulerModule } from '@modules/toolset/toolset-scheduler.module';
import { OAuthSchedulerModule } from '@modules/oauth/oauth-scheduler.module';
import { OperatorSchedulerModule } from '@modules/operator/operator-scheduler.module';

// Controllers
import { HealthcheckController } from '@shared/controllers/healthcheck.controller';
import { NetworkModule } from '@shared/network/network.module';
import { LastSeenSchedulerModule } from '@shared/last-seen/last-seen-scheduler.module';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig, bullmqConfig, observabilityConfig, authConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    // Schedule Module for Cron Jobs
    ScheduleModule.forRoot(),
    // BullMQ root — lets cron sweepers enqueue wakeup jobs
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => configService.get('bullmq'),
    }),
    // Infrastructure
    NetworkModule,
    DatabaseModule,
    RedisCacheModule,
    AlertingModule,
    WebSocketEmitterModule,
    // Domain Modules — payment intent expiry sweep
    PaymentSchedulerModule,
    // Call dispute snapshot retention (G3.B1).
    DisputeSchedulerModule,
    // Reconciliation / proof of reserves every five minutes
    SettlementSchedulerModule,
    // The evidence retention sweep, hourly, once per deployment.
    VerificationSchedulerModule,
    // Stake grace periods and on-chain exposure, every five minutes
    ProviderStakeMonitorSchedulerModule,
    // Closes SLA windows past their 7-day deadline, every five minutes
    ProviderSlaWindowSweepSchedulerModule,
    // Rebuilds `binding_stats` (the router's observed stats), every five minutes
    ProviderBindingStatsSchedulerModule,

    // Slash disputes: the two due-process sweepers and the execution pass.
    // In the scheduler only, so no API replica holds a key that can take a
    // provider's stake.
    SlashSchedulerModule,
    // The slash executor resolves `VerifierSigningService` through
    // `ModuleRef` to sign the attestation, and the scheduler is the only
    // process that executes a slash. Without this the signer is unreachable and
    // every execution fails with "no program id is configured for a verifier
    // signing capability", which is what kept a penalty from ever reaching the
    // chain even once the rest of the path worked.
    VerifierSigningModule,
    // The credential-expiry sweep (T-7d, T-1d, expiry).
    AccountSchedulerModule,
    // Free tier: the 30-day retention sweep over `tool_call_records`.
    FreeTierSchedulerModule,
    // The eip155 relayer float floor, every five minutes. Scheduler only:
    // the float is one account per chain, and one reading of it per API replica
    // would page five times for one dry relayer.
    EvmSchedulerModule,
    // Toolsets: grace and moderation-cutoff sweeps, daily and weekly usage stats.
    ToolsetSchedulerModule,
    // OAuth: dead tokens, codes and unreferenced clients, daily. Never credentials.
    OAuthSchedulerModule,
    // Operator approvals past their 24h window, stored as EXPIRED every 30 s.
    OperatorSchedulerModule,
    // "Last seen" stamps buffered in Redis, written in batches every 30 s.
    LastSeenSchedulerModule,
    // Starter reference modules — off by default in production
  ],
  controllers: [HealthcheckController],
})
export class AppSchedulerModule {}
