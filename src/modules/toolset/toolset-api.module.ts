import { Module } from '@nestjs/common';

import { McpModule } from '@modules/mcp/mcp.module';

import {
  AgentAccessController,
  CredentialAccessController,
} from './controllers/agent-access.controller';
import { RefusedCallsController } from './controllers/refused-calls.controller';
import { ToolsetsController } from './controllers/toolsets.controller';
import { ToolsetModule } from './toolset.module';

/**
 * The toolset routes on the API host. `McpModule` for the session source
 * `SessionAuthGuard` resolves tokens through.
 */
@Module({
  imports: [ToolsetModule, McpModule],
  controllers: [
    ToolsetsController,
    AgentAccessController,
    CredentialAccessController,
    RefusedCallsController,
  ],
})
export class ToolsetApiModule {}
