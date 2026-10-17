import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { FreeTierModule } from '@modules/free-tier/free-tier.module';
import { LedgerModule } from '@modules/ledger/ledger.module';
import { PaymentModule } from '@modules/payment/payment.module';
import { SpendPolicyModule } from '@modules/spend-policy/spend-policy.module';
import { ChainsModule } from '@modules/chains/chains.module';
import { AuthModule } from '@modules/auth/auth.module';
import { BlocklistModule } from '@modules/blocklist/blocklist.module';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { BlocklistSessionSource } from '@modules/blocklist/services/blocklist-session.source';
import { parseSessionSourceMode } from '@modules/auth/domain/session-source-mode';
import { createSessionSource } from '@modules/auth/services/composite-mcp-session.source';
import { DbCredentialMcpSessionSource } from '@modules/auth/services/db-credential-mcp-session.source';
import { PrivyMcpSessionSource } from '@modules/auth/services/privy-mcp-session.source';
import { ToolModule } from '@modules/tool/tool.module';
import { ToolsetModule } from '@modules/toolset/toolset.module';
import { VerificationModule } from '@modules/verification/verification.module';

import { MCP_SESSION_SOURCE } from './ports/mcp-session.port';
import {
  ConfigMcpSessionSource,
  MCP_CREDENTIAL_SNAPSHOT,
  loadMcpCredentials,
} from './services/config-mcp-session.source';
import { McpCatalogueService } from './services/mcp-catalogue.service';
import {
  DEFAULT_PLATFORM_FEE_BPS,
  MCP_PRICING,
  McpPricingConfig,
} from './services/mcp-pricing.config';
import {
  MCP_IDEMPOTENCY_CONFIG,
  McpIdempotencyStore,
  mcpIdempotencyConfigFactory,
} from './services/mcp-idempotency.store';
import { McpDiscoveryService } from './services/mcp-discovery.service';
import { McpServerFactory } from './services/mcp-server.factory';
import { McpToolCallService } from './services/mcp-tool-call.service';
import { CallAttributionWriter } from './services/call-attribution.writer';
import { McpCallRecorder } from './services/mcp-call-recorder.service';
import { McpRateLimiter } from './services/mcp-rate-limiter.service';

/**
 * MCP domain — the interface agents actually call.
 *
 * Scope: `tools/list` carrying live prices and `tools/call`; credential and session handling.
 *
 * ```text
 * McpServerFactory        one MCP Server per request, bound to one session
 *   ├── McpCatalogueService   tools/list — the catalogue, priced
 *   └── McpToolCallService    tools/call — intent → hold → route → classify → enqueue
 *         ├── PaymentModule       the intent and its hold
 *         ├── LedgerModule        the balance the hold is taken against
 *         ├── SpendPolicyModule   the gate that refuses the call before it costs
 *         ├── FreeTierModule      quotas, and the relay path for a free call
 *         ├── ToolModule          the router, and the quote behind every price
 *         └── VerificationModule  durably records a `DATA_RESULT` and wakes
 *                                 the asynchronous worker that judges it
 * ```
 *
 * This module is where the platform's four other domains meet, and it is the
 * only place that is true. That is not an accident of layering — it is what
 * the MCP server *is*: every piece it composes was built and tested with no
 * caller (the mapping engine, the classifier, the payment state machine), and
 * this is the module that gives all of them one.
 *
 * The transport lives in `mcp-http.module.ts`, not here, so that a process
 * which only needs to *price* tools does not also open an HTTP route that
 * spends money.
 *
 * Its error catalog: `errors/mcp.errors.ts`.
 */
@Module({
  imports: [
    AuthModule,
    // The blocklist that wraps `MCP_SESSION_SOURCE` below.
    BlocklistModule,
    // `ENABLED_CHAINS` alone: `McpToolCallService` and
    // `McpCatalogueService` name the deployment's chain set when they build a
    // `RoutingContext`. The router will not infer one.
    ChainsModule,
    ToolModule,
    PaymentModule,
    LedgerModule,
    VerificationModule,
    // Both are on the `tools/call` path before any money moves:
    // `SpendPolicyModule` refuses a call the agent's policy forbids, and
    // `FreeTierModule` decides whether the call costs anything at all.
    // `NOTIFICATION_PORT` arrives transitively through `PaymentModule` and
    // `LedgerModule`, which both need it for their own producers.
    SpendPolicyModule,
    FreeTierModule,
    // What each MCP URL serves and what each caller may use: the view, the
    // access policy and the agent rules a call is checked and routed under.
    ToolsetModule,
  ],
  providers: [
    // Empty until an operator points `MCP_CREDENTIALS_FILE` at a file. An empty
    // snapshot refuses every request, which is the correct behaviour for a
    // server with no issued credentials — and is loudly different from letting
    // an unauthenticated caller spend somebody's balance.
    { provide: MCP_CREDENTIAL_SNAPSHOT, useFactory: () => loadMcpCredentials() },
    ConfigMcpSessionSource,
    // The session sources for wallet login, added here as a third source.
    // Which identity provider(s) answer is configuration, not a code
    // path: `AUTH_SESSION_SOURCE` defaults to `config`, so this is
    // byte-for-byte the old behaviour until somebody opts in. `AuthModule`
    // never imports `McpModule` — only the port's interface file — so there
    // is no cycle.
    {
      provide: MCP_SESSION_SOURCE,
      useFactory: (
        config: ConfigService,
        configSource: ConfigMcpSessionSource,
        dbSource: DbCredentialMcpSessionSource,
        privySource: PrivyMcpSessionSource,
        blocklist: AccountBlocklistService,
      ) =>
        // The blocklist wraps whichever source is selected, so no source has
        // to remember to check it — see `BlocklistSessionSource`.
        new BlocklistSessionSource(
          createSessionSource(parseSessionSourceMode(config.get<string>('auth.sessionSource')), {
            config: configSource,
            db: dbSource,
            privy: privySource,
          }),
          blocklist,
        ),
      inject: [
        ConfigService,
        ConfigMcpSessionSource,
        DbCredentialMcpSessionSource,
        PrivyMcpSessionSource,
        AccountBlocklistService,
      ],
    },

    {
      provide: MCP_PRICING,
      useFactory: (config: ConfigService): McpPricingConfig => ({
        platformFeeBps: Number(
          config.get<string>('PLATFORM_FEE_BPS') ?? String(DEFAULT_PLATFORM_FEE_BPS),
        ),
      }),
      inject: [ConfigService],
    },

    {
      // `_meta["x402/idempotency-key"]`: how long a keyed call's result stays
      // replayable — the retry window, default 900 s, at most 3600 s — and the
      // largest output kept, default 256 KB. A bad value fails the boot.
      provide: MCP_IDEMPOTENCY_CONFIG,
      useFactory: (config: ConfigService) =>
        mcpIdempotencyConfigFactory(
          config.get<string>('MCP_IDEMPOTENCY_TTL_SECONDS'),
          config.get<string>('MCP_IDEMPOTENCY_MAX_RESULT_BYTES'),
        ),
      inject: [ConfigService],
    },
    McpIdempotencyStore,
    McpCatalogueService,
    McpToolCallService,
    McpDiscoveryService,
    McpServerFactory,
    CallAttributionWriter,
    McpCallRecorder,
    McpRateLimiter,
  ],
  exports: [
    McpCatalogueService,
    McpToolCallService,
    McpServerFactory,
    MCP_SESSION_SOURCE,
    ToolsetModule,
  ],
})
export class McpModule {}
