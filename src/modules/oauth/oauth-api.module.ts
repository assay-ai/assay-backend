import { Module } from '@nestjs/common';

import { FreeTierModule } from '@modules/free-tier/free-tier.module';
import { McpModule } from '@modules/mcp/mcp.module';

import { OAuthConsentController } from './controllers/oauth-consent.controller';
import { OAuthCoreModule } from './oauth-core.module';
import { OAuthConsentService } from './services/oauth-consent.service';
import { OAuthRequestStore } from './services/oauth-request.store';

/**
 * The OAuth routes of the API app: the consent API
 * (`{API}/oauth/requests/{rid}`, spec §6.3.5). Imported only by
 * `AppApiModule`.
 *
 * `McpModule` supplies the session source `SessionAuthGuard` needs (as every
 * `*-api.module.ts` does), `FreeTierModule` the free-call figure shown per
 * agent, and `OAuthCoreModule` the OAuth config, client registry and metrics.
 * The repositories come from the global `PostgresModule`, the Redis client
 * from the global `RedisCacheModule`.
 *
 * `OAuthRequestStore` is exported for the MCP app's `/oauth/authorize` and
 * `continue` (Task 1.11), which provide it there from the same class.
 */
@Module({
  imports: [OAuthCoreModule, McpModule, FreeTierModule],
  controllers: [OAuthConsentController],
  providers: [OAuthRequestStore, OAuthConsentService],
  exports: [OAuthRequestStore],
})
export class OAuthApiModule {}
