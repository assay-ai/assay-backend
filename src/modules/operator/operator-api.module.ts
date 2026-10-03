import { Module } from '@nestjs/common';

import { ChainsModule } from '@modules/chains/chains.module';
import { ProviderModule } from '@modules/provider/provider.module';
import { SlashModule } from '@modules/slash/slash.module';

import { OperatorCasesController } from './controllers/operator-cases.controller';
import { OperatorReferenceController } from './controllers/operator-reference.controller';
import { OperatorOverrideLogController } from './controllers/operator-override-log.controller';
import { OperatorProvidersController } from './controllers/operator-providers.controller';
import { OperatorModule } from './operator.module';
import { AdjudicationQueueService } from './services/adjudication-queue.service';
import { OperatorCaseService } from './services/operator-case.service';
import { OperatorProviderVerificationService } from './services/operator-provider-verification.service';
import { PlatformHealthService } from './services/platform-health.service';
import { OperatorReferenceService } from './services/operator-reference.service';

/**
 * The operator console's HTTP surface.
 *
 * Mounted by the API process only. Separate from `OperatorModule` for the
 * reason every `*-api.module.ts` here is: the scheduler needs the override log
 * and must not carry the console's controllers, and the console needs
 * `SlashModule` — which drags in the chain executor — while the register does
 * not.
 *
 * Every route behind these controllers reads across organizations by
 * construction, and does so behind `OperatorAuthGuard` rather than by
 * weakening any scoped repository. That separation is the whole design: there
 * is no route on which a provider's bearer token and an operator's reach the
 * same handler.
 */
@Module({
  // `ProviderModule` supplies `PROVIDER_STAKE_SOURCE` — the same port the
  // router's stake gate and `GET /providers/me/stake` read, so the console's
  // "Stake locked" tile cannot disagree with the figure a routing decision was
  // made on. Imported directly rather than inherited: a module imports what it
  // uses, and the alternative here would be re-exporting a stake port from the
  // slash domain, which has no business owning one.
  //
  // `ChainsModule` supplies `VERIFIER_REGISTRY` for the read-only verifier
  // panel — the on-chain allowlist is the only authority on which keys the
  // settlement program will accept, so the panel reads it rather than the
  // local custody table alone.
  imports: [OperatorModule, SlashModule, ProviderModule, ChainsModule],
  controllers: [
    OperatorCasesController,
    OperatorOverrideLogController,
    OperatorProvidersController,
    OperatorReferenceController,
  ],
  providers: [
    AdjudicationQueueService,
    OperatorCaseService,
    // `V-7`. `ProviderRepository` needs no import here — `PostgresModule` is
    // `@Global()`, and `OverrideLogService` already comes in with
    // `OperatorModule`.
    OperatorProviderVerificationService,
    PlatformHealthService,
    OperatorReferenceService,
  ],
})
export class OperatorApiModule {}
