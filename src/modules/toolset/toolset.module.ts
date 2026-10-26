import { Module } from '@nestjs/common';

import { EnabledChainsModule } from '@modules/chains/enabled-chains.module';
import { NotificationModule } from '@modules/notification/notification.module';
import { SpendPolicyModule } from '@modules/spend-policy/spend-policy.module';
import { ToolModule } from '@modules/tool/tool.module';
import { AuditLogModule } from '@shared/audit';

import { MCP_HOST_CONFIG, loadMcpHostConfig } from './config/mcp-host.config';
import { AccessEpochService } from './services/access-epoch.service';
import { AccessResolver } from './services/access.resolver';
import { AgentAccessService } from './services/agent-access.service';
import { ConnectUrlsService } from './services/connect-urls.service';
import { OfficialToolsetsService } from './services/official-toolsets.service';
import { ContractLifecycleService } from './services/contract-lifecycle.service';
import { HandlesService } from './services/handles.service';
import { McpEndpointResolver } from './services/mcp-endpoint.resolver';
import { RefusedCallsService } from './services/refused-calls.service';
import { PublicToolsetsService } from './services/public-toolsets.service';
import { ToolsetModerationService } from './services/toolset-moderation.service';
import { ToolsetNoticesService } from './services/toolset-notices.service';
import { ToolsetPublishingService } from './services/toolset-publishing.service';
import { ToolsetReportsService } from './services/toolset-reports.service';
import { ToolsetStatsService } from './services/toolset-stats.service';
import { ToolsetsService } from './services/toolsets.service';

/**
 * Toolsets, access policies and the MCP URLs that serve them (design spec,
 * phase T1).
 *
 * ```text
 * McpEndpointResolver   an MCP URL → what it serves to this organization   (the MCP host)
 * AccessResolver        a credential → what it may call, and its agent rules
 * AccessEpochService    the per-organization counter both caches are keyed on
 * ToolsetsService       a buyer's own toolsets and their Draft               (REST)
 * AgentAccessService    "What this agent can use", and per-key narrowing     (REST)
 * ConnectUrlsService    URLs handed out, and Servers in use                  (REST)
 * RefusedCallsService   calls refused before anything was charged            (REST)
 *
 * T2 publishing:
 * HandlesService            public names, the claim gate, URL handle resolution
 * ToolsetPublishingService  publish, stop sharing, rotate link, copy, versions
 * ToolsetNoticesService     FR-17 update notices
 * ToolsetReportsService     reports
 * ToolsetModerationService  delist, takedown, handle rename/reassign (the operator's writes)
 * ToolsetStatsService       daily and weekly usage figures
 * PublicToolsetsService     the anonymous toolset catalogue
 * ```
 *
 * The domain half, imported by the MCP service and the API alike; the routes
 * are `toolset-api.module.ts`. It never imports `McpModule`, which imports it.
 */
@Module({
  imports: [ToolModule, SpendPolicyModule, AuditLogModule, EnabledChainsModule, NotificationModule],
  providers: [
    { provide: MCP_HOST_CONFIG, useFactory: () => loadMcpHostConfig() },
    AccessEpochService,
    AccessResolver,
    McpEndpointResolver,
    ToolsetsService,
    AgentAccessService,
    ConnectUrlsService,
    RefusedCallsService,
    HandlesService,
    ToolsetPublishingService,
    ToolsetNoticesService,
    ToolsetReportsService,
    ToolsetModerationService,
    ToolsetStatsService,
    PublicToolsetsService,
    ContractLifecycleService,
    OfficialToolsetsService,
  ],
  exports: [
    MCP_HOST_CONFIG,
    AccessEpochService,
    AccessResolver,
    McpEndpointResolver,
    ToolsetsService,
    AgentAccessService,
    ConnectUrlsService,
    RefusedCallsService,
    HandlesService,
    ToolsetPublishingService,
    ToolsetNoticesService,
    ToolsetReportsService,
    ToolsetModerationService,
    ToolsetStatsService,
    PublicToolsetsService,
    ContractLifecycleService,
    OfficialToolsetsService,
  ],
})
export class ToolsetModule {}
