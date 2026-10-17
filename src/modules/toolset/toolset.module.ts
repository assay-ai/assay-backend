import { Module } from '@nestjs/common';

import { EnabledChainsModule } from '@modules/chains/enabled-chains.module';
import { SpendPolicyModule } from '@modules/spend-policy/spend-policy.module';
import { ToolModule } from '@modules/tool/tool.module';
import { AuditLogModule } from '@shared/audit';

import { MCP_HOST_CONFIG, loadMcpHostConfig } from './config/mcp-host.config';
import { AccessEpochService } from './services/access-epoch.service';
import { AccessResolver } from './services/access.resolver';
import { AgentAccessService } from './services/agent-access.service';
import { ConnectUrlsService } from './services/connect-urls.service';
import { McpEndpointResolver } from './services/mcp-endpoint.resolver';
import { RefusedCallsService } from './services/refused-calls.service';
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
 * ```
 *
 * The domain half, imported by the MCP service and the API alike; the routes
 * are `toolset-api.module.ts`. It never imports `McpModule`, which imports it.
 */
@Module({
  imports: [ToolModule, SpendPolicyModule, AuditLogModule, EnabledChainsModule],
  providers: [
    { provide: MCP_HOST_CONFIG, useFactory: () => loadMcpHostConfig() },
    AccessEpochService,
    AccessResolver,
    McpEndpointResolver,
    ToolsetsService,
    AgentAccessService,
    ConnectUrlsService,
    RefusedCallsService,
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
  ],
})
export class ToolsetModule {}
