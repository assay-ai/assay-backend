import { Module } from '@nestjs/common';

import { AuthModule } from './auth.module';
import { WalletLinkController } from './controllers/wallet-link.controller';
import { WalletLinkService } from './services/wallet-link.service';

/**
 * API-side auth module — imported only by `AppApiModule`.
 *
 * Separate from `AuthModule` for the reason every other `*-api.module.ts`
 * exists, with an extra edge here: `AuthModule` is imported by `McpModule`,
 * which loads in the worker, the scheduler and the facilitator too. A
 * controller declared inside it would be registered in four processes, three
 * of which serve no HTTP at all.
 */
@Module({
  imports: [AuthModule],
  controllers: [WalletLinkController],
  providers: [WalletLinkService],
})
export class AuthApiModule {}
