import { Module } from '@nestjs/common';

import { BlocklistModule } from '@modules/blocklist/blocklist.module';
import { ChainsModule } from '@modules/chains/chains.module';
import { DisputeModule } from '@modules/dispute/dispute.module';
import { ProviderModule } from '@modules/provider/provider.module';
import { SlashModule } from '@modules/slash/slash.module';
import { ToolModule } from '@modules/tool/tool.module';
import { ToolsetModule } from '@modules/toolset/toolset.module';
import { ProviderToolModule } from '@modules/provider-tool/provider-tool.module';

import { OperatorApprovalsController } from './controllers/operator-approvals.controller';
import { OperatorArbiterController } from './controllers/operator-arbiter.controller';
import { OperatorBlocksController } from './controllers/operator-blocks.controller';
import { OperatorModerationController } from './controllers/operator-moderation.controller';
import { OperatorContractsController } from './controllers/operator-contracts.controller';
import { OperatorCallDisputesController } from './controllers/operator-call-disputes.controller';
import { OperatorProviderToolsController } from './controllers/operator-provider-tools.controller';
import { OperatorCasesController } from './controllers/operator-cases.controller';
import { OperatorReferenceController } from './controllers/operator-reference.controller';
import { OperatorOperatorsController } from './controllers/operator-operators.controller';
import { OperatorOverrideLogController } from './controllers/operator-override-log.controller';
import { OperatorProvidersController } from './controllers/operator-providers.controller';
import { OperatorSignInController } from './controllers/operator-sign-in.controller';
import { OperatorModule } from './operator.module';
import { OperatorCaseBriefService } from './services/operator-case-brief.service';
import { OperatorAccountBlockService } from './services/operator-account-block.service';
import { OperatorApprovalService } from './services/operator-approval.service';
import { OperatorArbiterService } from './services/operator-arbiter.service';
import { OperatorCallDisputeService } from './services/operator-call-dispute.service';
import { OperatorCaseListService } from './services/operator-case-list.service';
import { OperatorCaseService } from './services/operator-case.service';
import { OperatorDirectoryService } from './services/operator-directory.service';
import { OperatorModerationService } from './services/operator-moderation.service';
import { OperatorContractsService } from './services/operator-contracts.service';
import { OperatorProviderToolsService } from './services/operator-provider-tools.service';
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
 * construction (sign-in aside), and does so behind `OperatorAuthGuard` rather than by
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
  //
  // `ToolModule` supplies `TOOL_CATALOGUE`, so the Penalties list names each
  // penalty's tool from the catalogue the case brief reads too.
  // `ToolsetModule` supplies the toolset and handle moderation writes the
  // moderation controller runs inside the register's transaction.
  imports: [
    OperatorModule,
    SlashModule,
    ProviderModule,
    ChainsModule,
    BlocklistModule,
    ToolModule,
    ToolsetModule,
    ProviderToolModule,
    // `CallDisputeService`, which `OperatorCallDisputeService` decides through (G3.B1).
    DisputeModule,
  ],
  controllers: [
    OperatorApprovalsController,
    OperatorArbiterController,
    OperatorBlocksController,
    OperatorModerationController,
    OperatorContractsController,
    OperatorProviderToolsController,
    OperatorCasesController,
    OperatorCallDisputesController,
    OperatorOperatorsController,
    OperatorOverrideLogController,
    OperatorProvidersController,
    OperatorSignInController,
    OperatorReferenceController,
  ],
  providers: [
    OperatorCaseBriefService,
    OperatorAccountBlockService,
    OperatorApprovalService,
    OperatorArbiterService,
    OperatorCallDisputeService,
    OperatorCaseListService,
    OperatorCaseService,
    OperatorDirectoryService,
    OperatorModerationService,
    OperatorContractsService,
    OperatorProviderToolsService,
    // `V-7`. `ProviderRepository` needs no import here — `PostgresModule` is
    // `@Global()`, and `OverrideLogService` already comes in with
    // `OperatorModule`.
    OperatorProviderVerificationService,
    PlatformHealthService,
    OperatorReferenceService,
  ],
})
export class OperatorApiModule {}
