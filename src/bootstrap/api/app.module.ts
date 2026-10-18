import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { appConfig } from '@config/app.config';
import { observabilityConfig } from '@config/observability.config';
import { authConfig } from '@config/auth.config';
import { databaseConfig } from '@config/database.config';
import { redisConfig } from '@config/redis.config';
import { jwtConfig } from '@config/jwt.config';
import { bullmqConfig } from '@config/bullmq.config';
import { bullboardConfig } from '@config/bullboard.config';

// Infrastructure
import { DatabaseModule } from '@database/database.module';
import { AlertingModule } from '@shared/alerting';
import { RedisCacheModule } from '@shared/cache/redis-cache/redis-cache.module';
import { RedisAdapterModule } from '@shared/cache/redis-adapter/redis-adapter.module';
import { HttpCacheModule } from '@shared/cache/http-cache/http-cache.module';
import { BullBoardConfigModule } from '../../bull-board/bull-board.module';

// Domain Modules
import { ChainsApiModule } from '@modules/chains/chains-api.module';
import { PaymentModule } from '@modules/payment/payment.module';
import { PaymentApiModule } from '@modules/payment/payment-api.module';
import { LedgerApiModule } from '@modules/ledger/ledger-api.module';
import { ToolModule } from '@modules/tool/tool.module';
import { ToolApiModule } from '@modules/tool/tool-api.module';
import { ToolEgressModule } from '@modules/tool/tool-egress.module';
import { CatalogueApiModule } from '@modules/catalogue/catalogue-api.module';
import { ProviderModule } from '@modules/provider/provider.module';
import { ProviderApiModule } from '@modules/provider/provider-api.module';
import { ProviderToolModule } from '@modules/provider-tool/provider-tool.module';
import { VerificationModule } from '@modules/verification/verification.module';
import { VerificationApiModule } from '@modules/verification/verification-api.module';
import { SettlementModule } from '@modules/settlement/settlement.module';
import { McpApiModule, isPublicDemoConfigured } from '@modules/mcp/mcp-api.module';
import {
  PublicReservesApiModule,
  isPublicReservesConfigured,
} from '@modules/settlement/public-reserves-api.module';
import { SettlementApiModule } from '@modules/settlement/settlement-api.module';
import { McpModule } from '@modules/mcp/mcp.module';

// REST surface — the modules that exist to serve the dashboards.
// `account` (notifications, audit log, agents, credentials), `spend-policy`
// (limits and their version history) and `dispute` are new here; the rest
// extend a domain module that already existed.
import { AccountApiModule } from '@modules/account/account-api.module';
import { AuthApiModule } from '@modules/auth/auth-api.module';
import { SpendPolicyApiModule } from '@modules/spend-policy/spend-policy-api.module';
import { ToolsetApiModule } from '@modules/toolset/toolset-api.module';
import { McpUrlsApiModule } from '@modules/mcp/mcp-urls-api.module';
import { NotificationApiModule } from '@modules/notification/notification-api.module';
import { FreeTierApiModule } from '@modules/free-tier/free-tier-api.module';
import { DisputeApiModule } from '@modules/dispute/dispute-api.module';
import { OperatorApiModule } from '@modules/operator/operator-api.module';
import { SlashModule } from '@modules/slash/slash.module';
import { ToolRequestModule } from '@modules/tool-request/tool-request.module';
import { ObservabilityModule } from '@modules/observability/observability.module';

// Diagnostics (error-contract probe)
import { DiagnosticsModule } from '@shared/diagnostics/diagnostics.module';
import { areDiagnosticsEnabled } from '@shared/diagnostics/diagnostics.flag';

// Starter reference modules — see src/modules/_examples/README.md
import { ExamplesApiModule } from '@modules/_examples/examples-api.module';
import { areExamplesEnabled } from '@modules/_examples/examples.flag';

// WebSocket
import { WebSocketEmitterModule } from '@websocket/websocket-emitter.module';
import { WebSocketBoardModule } from '@websocket/websocket-board.module';

// Controllers
import { HealthcheckController } from '@shared/controllers/healthcheck.controller';

import { PublicFeaturesController } from './public-features.controller';
import { RequestKeysController } from './request-keys.controller';

// Providers
import { SingleFlightService } from '@shared/services/single-flight.service';
import { NetworkModule } from '@shared/network/network.module';

@Module({
  imports: [
    // ConfigModule.forRoot loads .env files synchronously into process.env on
    // this call — keep it first so the env-gated imports below see the
    // correct values.
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        databaseConfig,
        redisConfig,
        jwtConfig,
        bullmqConfig,
        bullboardConfig,
        observabilityConfig,
        authConfig,
      ],
      envFilePath: ['.env.local', '.env'],
    }),
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
    HttpCacheModule,
    // `ALERT_PORT` — global, so a domain never has to remember to import it
    AlertingModule,
    // WebSocket Emitter (for publishing events from API)
    WebSocketEmitterModule,
    // Domain Modules
    // `GET /chains`, the only source of "which chains does this
    // deployment offer". The api-only half of `chains/`: the worker, scheduler
    // and MCP bootstraps import `ChainsModule` for its ports and must not gain
    // an HTTP route by doing so.
    ChainsApiModule,
    PaymentModule,
    PaymentApiModule,
    LedgerApiModule,
    ToolModule,
    // The provider call (invoker, request signer, credential vault): the
    // mapping tester and the public demo dial providers, and the JWKS route
    // publishes the signer's keys.
    ToolEgressModule,
    ToolApiModule,
    CatalogueApiModule,
    ProviderModule,
    ProviderApiModule,
    ProviderToolModule,
    VerificationModule,
    VerificationApiModule,
    SettlementModule,
    // `GET /escrow` and the buyer-signed intent builders. Core, so
    // unconditional: an escrow route that disappears with a feature flag is a
    // buyer who cannot see or move their own money.
    SettlementApiModule,
    // The public `/reserves` page. Registered ONLY when
    // `PUBLIC_RESERVES_ASSET` names an asset, so an unconfigured deployment
    // 404s the route and the page says so, rather than rendering zeros that
    // read as "no reserves". The call is inline, after `ConfigModule.forRoot`
    // above, per docs/architecture.md §"Feature Flags". Separate module from
    // `SettlementApiModule` because their lifetimes differ — see
    // `public-reserves-api.module.ts`.
    ...(isPublicReservesConfigured() ? [PublicReservesApiModule] : []),
    McpModule,
    // The public live demo. Registered ONLY when the demo credential
    // is configured, so an unconfigured deployment 404s and the page says so
    // rather than rendering a demo that cannot run. Inline, after
    // `ConfigModule.forRoot` above, per docs/architecture.md §"Feature Flags".
    ...(isPublicDemoConfigured() ? [McpApiModule] : []),
    // Dashboard REST surface
    AccountApiModule,
    // `POST /auth/wallet/link`, the only route that verifies a Privy
    // token without building a session (it exists to clear the condition that
    // stops one being built).
    AuthApiModule,
    SpendPolicyApiModule,
    // Toolsets, access policies, the Connect preview and Servers in use.
    ToolsetApiModule,
    McpUrlsApiModule,
    // The notification channel registry and per-event preferences,
    // and `GET /free-quota`. `NotificationApiModule` is the settings surface;
    // the notification *feed* is still `AccountApiModule`'s.
    NotificationApiModule,
    FreeTierApiModule,
    DisputeApiModule,

    // Slash proposals, disputes and the operator console. Two surfaces, deliberately separate: the
    // provider reads their own case through `SessionAuthGuard`, and the
    // operator reads every case through `OperatorAuthGuard`. No route is
    // reachable by both.
    SlashModule,
    ObservabilityModule,
    OperatorApiModule,
    ToolRequestModule,
    ...(process.env.BULLBOARD_ENABLED === 'true'
      ? [BullBoardConfigModule, WebSocketBoardModule]
      : []),
    // Diagnostics — off by default in production
    ...(areDiagnosticsEnabled() ? [DiagnosticsModule] : []),
    // Starter reference modules — off by default in production
    ...(areExamplesEnabled() ? [ExamplesApiModule] : []),
  ],
  providers: [SingleFlightService],
  controllers: [HealthcheckController, PublicFeaturesController, RequestKeysController],
})
export class AppApiModule {}
