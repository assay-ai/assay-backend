import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { AgentConnectUrlRepository } from '@database/postgres/repositories/agent-connect-url.repository';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { OrganizationRepository } from '@database/postgres/repositories/organization.repository';
import { SpendPolicyRepository } from '@database/postgres/repositories/spend-policy.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { ToolVersionRepository } from '@database/postgres/repositories/tool-version.repository';
import {
  ModerationCutoffRepository,
  OrgHandleClaimRepository,
  OrgHandleHistoryRepository,
  ToolsetReportRepository,
  ToolsetStatsRepository,
  ToolsetVersionRepository,
} from '@database/postgres/repositories/toolset-sharing.repository';
import {
  ToolsetEntryRepository,
  ToolsetRepository,
} from '@database/postgres/repositories/toolset.repository';
import { NotificationPort } from '@modules/notification/ports/notification.port';
import { SpendPolicyEnforcementService } from '@modules/spend-policy/services/spend-policy-enforcement.service';
import { SpendPolicyService } from '@modules/spend-policy/services/spend-policy.service';
import { ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { McpHostConfig } from '@modules/toolset/config/mcp-host.config';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { AccessResolver } from '@modules/toolset/services/access.resolver';
import { AgentAccessService } from '@modules/toolset/services/agent-access.service';
import { ConnectUrlsService } from '@modules/toolset/services/connect-urls.service';
import { HandlesService } from '@modules/toolset/services/handles.service';
import { McpEndpointResolver } from '@modules/toolset/services/mcp-endpoint.resolver';
import { PublicToolsetsService } from '@modules/toolset/services/public-toolsets.service';
import { ToolsetClock } from '@modules/toolset/services/toolset-clock';
import { ToolsetModerationService } from '@modules/toolset/services/toolset-moderation.service';
import { ToolsetNoticesService } from '@modules/toolset/services/toolset-notices.service';
import { ToolsetPublishingService } from '@modules/toolset/services/toolset-publishing.service';
import { ToolsetReportsService } from '@modules/toolset/services/toolset-reports.service';
import { ToolsetStatsService } from '@modules/toolset/services/toolset-stats.service';
import { ToolsetsService } from '@modules/toolset/services/toolsets.service';
import { AuditLogWriter } from '@shared/audit';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

export interface ToolsetTestContextOptions {
  readonly dataSource: DataSource;
  readonly redis: Redis;
  readonly host: McpHostConfig;
  readonly catalogue: ToolCataloguePort;
  readonly chainId: string;
  readonly notifications?: NotificationPort;
  readonly clock?: ToolsetClock;
}

/** Every toolset service, wired the way `ToolsetModule` wires them, on a real database and Redis. */
export function toolsetTestContext(options: ToolsetTestContextOptions) {
  const { dataSource, host } = options;
  const clock = options.clock;
  const epochs = new AccessEpochService(new CacheService(options.redis));
  const toolsets = new ToolsetRepository(dataSource);
  const entries = new ToolsetEntryRepository(dataSource);
  const tools = new ToolRepository(dataSource);
  const policies = new SpendPolicyRepository(dataSource);
  const credentials = new AgentCredentialRepository(dataSource);
  const versions = new ToolsetVersionRepository(dataSource);
  const stats = new ToolsetStatsRepository(dataSource);
  const audit = new AuditLogWriter(dataSource);
  const handles = new HandlesService(
    new OrganizationRepository(dataSource),
    new AgentRepository(dataSource),
    new OrgHandleHistoryRepository(dataSource),
    new OrgHandleClaimRepository(dataSource),
    audit,
    dataSource,
    clock,
  );
  const resolver = new AccessResolver(policies, credentials, toolsets, entries, epochs, versions);
  const connectUrls = new ConnectUrlsService(
    new AgentConnectUrlRepository(dataSource),
    toolsets,
    dataSource,
    host,
    handles,
  );
  const owned = new ToolsetsService(
    toolsets,
    entries,
    tools,
    new ToolVersionRepository(dataSource),
    epochs,
    audit,
    dataSource,
    host,
    handles,
    clock,
  );
  const sent: Parameters<NotificationPort['notify']>[0][] = [];
  const notifications: NotificationPort = options.notifications ?? {
    notify: async (request) => {
      sent.push(request);
      return { deliveredNow: true };
    },
  };
  const notices = new ToolsetNoticesService(
    toolsets,
    versions,
    handles,
    notifications,
    dataSource,
    host,
    clock,
  );
  const publishing = new ToolsetPublishingService(
    toolsets,
    entries,
    versions,
    tools,
    stats,
    owned,
    handles,
    epochs,
    audit,
    dataSource,
    notices,
    clock,
  );
  return {
    epochs,
    handles,
    resolver,
    connectUrls,
    toolsets: owned,
    publishing,
    notices,
    sent,
    endpoints: new McpEndpointResolver(
      toolsets,
      entries,
      epochs,
      host,
      versions,
      handles,
      options.catalogue,
      clock,
    ),
    access: new AgentAccessService(
      new AgentRepository(dataSource),
      credentials,
      policies,
      new SpendPolicyService(policies, dataSource, audit),
      new SpendPolicyEnforcementService(
        policies,
        null as never,
        null as never,
        null as never,
        null as never,
      ),
      toolsets,
      tools,
      options.catalogue,
      { quoteMany: async () => new Map() } as never,
      resolver,
      epochs,
      connectUrls,
      audit,
      { get: () => undefined } as never,
      dataSource,
      [options.chainId as never],
      versions,
      handles,
    ),
    reports: new ToolsetReportsService(
      new ToolsetReportRepository(dataSource),
      toolsets,
      tools,
      handles,
      clock,
    ),
    moderation: new ToolsetModerationService(
      new ModerationCutoffRepository(dataSource),
      handles,
      epochs,
      dataSource,
      clock,
    ),
    stats: new ToolsetStatsService(dataSource, clock),
    publicToolsets: new PublicToolsetsService(
      toolsets,
      versions,
      stats,
      handles,
      dataSource,
      host,
      epochs,
      clock,
    ),
  };
}
