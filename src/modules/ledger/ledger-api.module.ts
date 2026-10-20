import { Module } from '@nestjs/common';

import { ChainsModule } from '@modules/chains/chains.module';
import { McpModule } from '@modules/mcp/mcp.module';

import { BalancesController } from './controllers/balances.controller';
import { DepositsController } from './controllers/deposits.controller';
import { HoldsController } from './controllers/holds.controller';
import { WithheldController } from './controllers/withheld.controller';
import { StatementsController } from './controllers/statements.controller';
import { WithdrawalsController } from './controllers/withdrawals.controller';
import { LedgerModule } from './ledger.module';
import { StatementService } from './services/statement.service';
import { WithdrawalsService } from './services/withdrawals.service';

/**
 * API-side ledger module — imported only by `AppApiModule`.
 *
 * Imports `McpModule` for one reason: it is what exports `MCP_SESSION_SOURCE`,
 * the DI token `SessionAuthGuard` resolves bearer tokens through
 * (`shared/auth/session-auth.guard.ts`). None of the controllers here depend
 * on anything else McpModule provides.
 */
@Module({
  // `ChainsModule`: `ESCROW_BALANCE_READER`, which the statement check reads.
  imports: [LedgerModule, McpModule, ChainsModule],
  controllers: [
    BalancesController,
    WithheldController,
    HoldsController,
    DepositsController,
    WithdrawalsController,
    StatementsController,
  ],
  // Read-only reporting (B7), like `DepositsService`; API-side only.
  providers: [WithdrawalsService, StatementService],
  exports: [LedgerModule],
})
export class LedgerApiModule {}
