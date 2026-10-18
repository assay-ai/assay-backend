import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { appConfig } from '@config/app.config';
import { observabilityConfig } from '@config/observability.config';
import { authConfig } from '@config/auth.config';
import { bullmqConfig } from '@config/bullmq.config';
import { databaseConfig } from '@config/database.config';
import { redisConfig } from '@config/redis.config';

// Infrastructure. `DatabaseModule` because every tool call writes a payment
// intent and a ledger entry; `RedisCacheModule` because the voucher nonce store
// and the cache service are `@Global` dependencies of the payment domain.
import { DatabaseModule } from '@database/database.module';
import { AlertingModule } from '@shared/alerting';
import { RedisCacheModule } from '@shared/cache/redis-cache/redis-cache.module';
import { HealthcheckController } from '@shared/controllers/healthcheck.controller';
import { NetworkModule } from '@shared/network/network.module';

import { McpHttpModule } from '@modules/mcp/mcp-http.module';
import { ToolEgressModule } from '@modules/tool/tool-egress.module';

/**
 * The MCP service.
 *
 * Its own process because it is its own scaling unit: the HTTP transport is
 * stateless per request, so this is the one service that scales purely on agent
 * traffic, independently of the dashboard API and of the workers behind it.
 *
 * What it deliberately does **not** import:
 *
 *  - `WebSocketEmitterModule` — nothing on this path emits a websocket event.
 *  - `BullBoardConfigModule`, Swagger, `DiagnosticsModule`, the examples — an
 *    endpoint reachable by every agent on the internet is the wrong place to
 *    mount an operator console.
 *  - `FacilitatorModule` — the fee-payer signer stays out of this address
 *    space, same rule as the API.
 *
 * `BullModule` **is** imported — the one exception to "an MCP
 * tool call is synchronous end to end". A `DATA_RESULT` is now handed to the
 * asynchronous verification worker via `VerificationSettlementService.enqueue`,
 * which publishes a wakeup onto `verification.judge`; this process needs the
 * BullMQ root connection to do that, and nothing more. It never registers a
 * `@Processor()` — see `verification-worker.module.ts`, which only the worker
 * bootstrap imports — so this process publishes and consumes nothing.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig, bullmqConfig, observabilityConfig, authConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => configService.get('bullmq'),
    }),
    NetworkModule,
    DatabaseModule,
    RedisCacheModule,
    AlertingModule,
    // `tools/call` dials providers: the invoker, the request signer and the
    // credential vault. The scheduler does not import this, so it needs neither
    // `PROVIDER_REQUEST_SIGNING_KEYS` nor `CREDENTIAL_VAULT_KEKS`.
    ToolEgressModule,
    McpHttpModule,
  ],
  controllers: [HealthcheckController],
})
export class AppMcpModule {}
