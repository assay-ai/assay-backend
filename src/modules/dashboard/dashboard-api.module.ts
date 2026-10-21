import { Module } from '@nestjs/common';

import { AccountModule } from '@modules/account/account.module';
import { AccountBlockStatusService } from '@modules/account/services/account-block-status.service';
import { BlocklistModule } from '@modules/blocklist/blocklist.module';
import { DisputeModule } from '@modules/dispute/dispute.module';
import { LedgerModule } from '@modules/ledger/ledger.module';
import { McpModule } from '@modules/mcp/mcp.module';
import { PaymentApiModule } from '@modules/payment/payment-api.module';
import { PaymentModule } from '@modules/payment/payment.module';
import { VerificationApiModule } from '@modules/verification/verification-api.module';

import { MeStatusController } from './controllers/me-status.controller';
import { OverviewController } from './controllers/overview.controller';
import { OverviewService } from './services/overview.service';

/**
 * Composite reads for the dashboard — imported only by `AppApiModule`.
 *
 * Owns no data and no figure: `GET /overview` and `GET /me/status` answer
 * with the responses of routes other modules own, through those modules'
 * services, so a screen can make one request where it made many. The imports
 * are exactly the modules those services live in:
 *
 * - `LedgerModule`: `BalancesService`, `HoldsService`;
 * - `VerificationApiModule`: `ReceiptSummaryService`;
 * - `PaymentModule`: `ToolCallsService`; `PaymentApiModule`: `BuyerDebtService`
 *   (provided there, with the next-seq throttle it shares);
 * - `DisputeModule`: `RefundEligibilityService`, as `/tool-calls` uses it;
 * - `AccountModule`: `NotificationsService`;
 * - `BlocklistModule`: what `AccountBlockStatusService` reads (stateless, so
 *   provided here as `AccountApiModule` provides it);
 * - `McpModule`: `MCP_SESSION_SOURCE`, for `SessionAuthGuard`.
 */
@Module({
  imports: [
    McpModule,
    LedgerModule,
    VerificationApiModule,
    PaymentModule,
    PaymentApiModule,
    DisputeModule,
    AccountModule,
    BlocklistModule,
  ],
  controllers: [OverviewController, MeStatusController],
  providers: [OverviewService, AccountBlockStatusService],
})
export class DashboardApiModule {}
