import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { ChainsModule } from '@modules/chains/chains.module';
import { DisputeModule } from '@modules/dispute/dispute.module';
import { FeePayerSignerModule } from '@modules/chains/facilitator/signing/fee-payer-signer.module';
import { McpModule } from '@modules/mcp/mcp.module';
import { SpendPolicyModule } from '@modules/spend-policy/spend-policy.module';
import { RedisDemoRateLimiter } from '@modules/mcp/services/redis-demo-rate-limiter.service';
import { ToolModule } from '@modules/tool/tool.module';

import { NEXT_SEQ_RATE_LIMITER, NEXT_SEQ_RATE_LIMITS } from './constants/escrow-seq.constants';

import { DepositsController } from './controllers/deposits.controller';
import { EscrowController } from './controllers/escrow.controller';
import { ToolCallsController } from './controllers/tool-calls.controller';
import { PaymentModule } from './payment.module';
import { BuyerDebtService } from './services/buyer-debt.service';
import { NextSeqService } from './services/next-seq.service';

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
  // `ToolModule` for `TOOL_CATALOGUE`: a debt's replacement voucher names the
  // tool's resource, and an intent older than `voucher_resource` keeps only the
  // tool id. `SpendPolicyModule`: a delegate-signed replacement meets the
  // agent's spend policy (review-buyer-debt M4).
  imports: [
    PaymentModule,
    McpModule,
    ChainsModule,
    FeePayerSignerModule,
    ToolModule,
    SpendPolicyModule,
    // `RefundEligibilityService`: `GET /tool-calls?refundable=true` uses the
    // receipt's predicate. `DisputeModule` imports `PaymentModule`, not this
    // API module, so there is no cycle.
    DisputeModule,
  ],
  controllers: [ToolCallsController, DepositsController, EscrowController],
  providers: [
    NextSeqService,
    BuyerDebtService,
    {
      // `GET /escrow/next-seq`'s throttle (review S2-2): the demo's sliding
      // window under its own keys, on its own connection for the reason
      // `mcp-api.module.ts` gives (it must not queue behind cache traffic).
      provide: NEXT_SEQ_RATE_LIMITER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new RedisDemoRateLimiter(
          new Redis(config.get<string>('redis.url') as string, {
            password: config.get<string>('redis.password') || undefined,
            maxRetriesPerRequest: 1,
            enableReadyCheck: true,
          }),
          NEXT_SEQ_RATE_LIMITS,
          'escrow:next-seq:rate:',
        ),
    },
  ],
  exports: [PaymentModule],
})
export class PaymentApiModule {}
