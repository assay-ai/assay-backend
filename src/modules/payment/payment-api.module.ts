import { Module } from '@nestjs/common';

import { ChainsModule } from '@modules/chains/chains.module';
import { FeePayerSignerModule } from '@modules/chains/facilitator/signing/fee-payer-signer.module';
import { McpModule } from '@modules/mcp/mcp.module';

import { DepositsController } from './controllers/deposits.controller';
import { EscrowController } from './controllers/escrow.controller';
import { ToolCallsController } from './controllers/tool-calls.controller';
import { PaymentModule } from './payment.module';

/**
 * API-side payment module — imported only by `AppApiModule`.
 *
 * `ToolCallsController`, and `DepositsController`, the two deposit
 * writes — `GET /deposits` is `LedgerApiModule`'s, and both controller class
 * docs explain why one prefix is split across two modules. Follows the same
 * shape as `ledger-api.module.ts` / `verification-api.module.ts` — `McpModule`
 * is imported for exactly one reason, `MCP_SESSION_SOURCE`, the DI token
 * `SessionAuthGuard` resolves bearer tokens through.
 *
 * `EscrowController` — `GET /escrow/next-seq`, authenticated by the
 * same agent credential as `POST /tool-calls`, because the caller is the agent
 * that signs vouchers and not a console user.
 *
 * `ChainsModule` is imported for exactly one reason too: `SolanaBlockhashService`,
 * which `DepositsController` injects to hand the browser a blockhash to sign
 * over. `PaymentModule` imports `ChainsModule` but does not re-export it, and
 * it should not start to — a module that re-exports its own dependencies makes
 * every importer's graph implicit.
 *
 * `FeePayerSignerModule` is what puts a fee-payer key in this
 * process, and this is now the **second** bootstrap that imports it (the
 * scheduler, for `redeem_voucher`, is the first) — `POST /deposits` opens a
 * brand-new buyer's escrow inline, and `SolanaEscrowOpener` resolves
 * `FEE_PAYER_SIGNER` through `ModuleRef` at call time exactly as
 * `SolanaVoucherRedeemer` does. Without this import that resolution fails
 * loudly at the first deposit from a buyer with no escrow yet, naming this
 * line.
 */
@Module({
  imports: [PaymentModule, McpModule, ChainsModule, FeePayerSignerModule],
  controllers: [ToolCallsController, DepositsController, EscrowController],
  exports: [PaymentModule],
})
export class PaymentApiModule {}
