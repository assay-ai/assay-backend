import { Module } from '@nestjs/common';

import { McpModule } from '@modules/mcp/mcp.module';
import { OperatorIdentityModule } from '@modules/operator/operator-identity.module';

import { OperatorToolRequestsController } from './controllers/operator-tool-requests.controller';
import { ToolRequestsController } from './controllers/tool-requests.controller';
import { ToolRequestQueueService } from './services/operator-tool-request-queue.service';
import { ToolRequestService } from './services/tool-request.service';

/**
 * The tool request queue (MVP slice only). A ticket, a named owner,
 * a two-working-day clock. No submitted schema, no review rounds, no
 * revision history, no accept-into-catalogue path — see
 * `CreateToolRequestBodyDto`'s docstring for why.
 *
 * `McpModule` for `MCP_SESSION_SOURCE` (`SessionAuthGuard`, the provider
 * controller) — every module that mounts a `SessionAuthGuard` route imports
 * this for the same reason `SlashModule` does: the guard resolves the tenant,
 * so the module that mounts the route owns the dependency.
 *
 * `OperatorIdentityModule` rather than `OperatorModule` — this controller
 * needs `OPERATOR_SESSION_SOURCE` (`OperatorAuthGuard`) and nothing else. It
 * deliberately does not import `OperatorModule` for `OverrideLogService`:
 * see `OperatorToolRequestsController`'s docstring for why answering a ticket
 * is not a register override, and importing the override log for a write path
 * that never calls it would be a dependency with no caller.
 *
 * `ToolRequestRepository` is not provided here — it is registered on
 * `postgres.module.ts` (`@Global`), as every repository is, and injected
 * directly; this module does not own that file.
 */
@Module({
  imports: [McpModule, OperatorIdentityModule],
  controllers: [ToolRequestsController, OperatorToolRequestsController],
  providers: [ToolRequestService, ToolRequestQueueService],
  exports: [ToolRequestService, ToolRequestQueueService],
})
export class ToolRequestModule {}
