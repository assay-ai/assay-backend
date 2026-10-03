import { Module } from '@nestjs/common';

import { McpModule } from '@modules/mcp/mcp.module';

import { ReceiptsController } from './controllers/receipts.controller';
import { VerdictsController } from './controllers/verdicts.controller';
import { ReceiptSummaryService } from './services/receipt-summary.service';
import { ReceiptService } from './services/receipt.service';
import { VerdictService } from './services/verdict.service';
import { VerificationModule } from './verification.module';

/**
 * API-side verification module — imported only by `AppApiModule`.
 *
 * `ReceiptService`, `ReceiptSummaryService` and `VerdictService` read
 * `payment_intents`, `verification_records` and `verification_policies`
 * directly through the repositories `PostgresModule` provides globally, so
 * this module needs no import of `VerificationModule` itself — every read
 * here is a read side over rows another module writes, not a consumer of
 * the policy store or the kill switch. `VerdictService` is the
 * verdict feed, one verdict in full, and its evidence pack — see
 * `controllers/verdicts.controller.ts`.
 *
 * Imports `McpModule` for one reason: it exports `MCP_SESSION_SOURCE`, the DI
 * token `SessionAuthGuard` resolves bearer tokens through
 * (`shared/auth/session-auth.guard.ts`).
 */
@Module({
  imports: [McpModule, VerificationModule],
  controllers: [ReceiptsController, VerdictsController],
  providers: [ReceiptService, ReceiptSummaryService, VerdictService],
  exports: [ReceiptService, ReceiptSummaryService, VerdictService],
})
export class VerificationApiModule {}
