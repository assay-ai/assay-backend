import { Module } from '@nestjs/common';

import { ChainsModule } from '@modules/chains/chains.module';
import { readVerifiedClients } from '@modules/oauth/config/oauth-verified-client-ids';
import { builtinClientId } from '@modules/oauth/domain/client-id';
import { OAUTH_CLIENT_TRUST, OAuthClientTrust } from '@modules/oauth/domain/credential-client-view';
import { MCP_HOST_CONFIG, McpHostConfig } from '@modules/toolset/config/mcp-host.config';
import { ToolsetModule } from '@modules/toolset/toolset.module';
import { AuditLogModule } from '@shared/audit';

import { AgentCredentialsService } from './services/agent-credentials.service';
import { AgentDelegateService } from './services/agent-delegate.service';
import { AgentsService } from './services/agents.service';
import { AuditLogService } from './services/audit-log.service';
import { NotificationsService } from './services/notifications.service';

/**
 * Account domain — notifications, the audit log, agents, and agent
 * credentials.
 *
 * The repositories these services use (`NotificationRepository`,
 * `AuditLogEntryRepository`, `AgentRepository`, `AgentCredentialRepository`,
 * plus `PaymentIntentRepository` / `VerificationRecordRepository` in the
 * sibling `payment` module for `tool-calls`) are provided globally by
 * `PostgresModule`, and `ConfigService` by the globally-registered
 * `ConfigModule`, so this module needs no `imports` for any of them — same
 * pattern as `PaymentModule`.
 *
 * `ToolsetModule` for `AccessEpochService` (a revoke invalidates cached
 * access) and `MCP_HOST_CONFIG`. `OAUTH_CLIENT_TRUST` is what the credentials
 * list needs to describe a grant's client; it reads `OAUTH_VERIFIED_CLIENTS`
 * on its own rather than `OAUTH_CONFIG`, which demands the OAuth secrets.
 */
@Module({
  imports: [ChainsModule, AuditLogModule, ToolsetModule],
  providers: [
    {
      provide: OAUTH_CLIENT_TRUST,
      inject: [MCP_HOST_CONFIG],
      useFactory: (host: McpHostConfig): OAuthClientTrust => ({
        builtinClientId: builtinClientId(host.mcpPublicUrl),
        // Unreadable → no client is shown as verified.
        verifiedClients: readVerifiedClients() ?? [],
      }),
    },
    NotificationsService,
    AuditLogService,
    AgentsService,
    AgentCredentialsService,
    AgentDelegateService,
  ],
  exports: [
    NotificationsService,
    AuditLogService,
    AgentsService,
    AgentCredentialsService,
    AgentDelegateService,
  ],
})
export class AccountModule {}
