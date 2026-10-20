import { Module } from '@nestjs/common';

import { ChainsModule } from '@modules/chains/chains.module';
import { McpModule } from '@modules/mcp/mcp.module';
import { LedgerModule } from '@modules/ledger/ledger.module';
import { NotificationModule } from '@modules/notification/notification.module';
import { ProviderModule } from '@modules/provider/provider.module';
import { ToolModule } from '@modules/tool/tool.module';
import { OperatorModule } from '@modules/operator/operator.module';

import { ConfigService } from '@nestjs/config';

import {
  PROVIDER_MINIMUM_STAKE_PARAMETERS,
  ProviderStakeService,
  loadMinimumStakeParameters,
} from '@modules/provider/services/provider-stake.service';

import {
  SLASH_CONFIG,
  SLASH_PRORATA_CONFIG,
  loadProRataSlashConfig,
  loadSlashConfig,
} from './constants/slash.constants';
import { ProviderSlashProposalsController } from './controllers/provider-slash-proposals.controller';
import { ProviderSlashRequestsController } from './controllers/provider-slash-requests.controller';
import { SlashDisputeIntentService } from './services/slash-dispute-intent.service';
import { SlashRequestLookupService } from './services/slash-request-lookup.service';
import { ArbitrationService } from './services/arbitration.service';
import { SlashCaseService } from './services/slash-case.service';
import { SlashCompensationService } from './services/slash-compensation.service';
import { SlashExecutionService } from './services/slash-execution.service';
import { SlashPartsService } from './services/slash-parts.service';
import { SlashStuckCaseService } from './services/slash-stuck-case.service';
import { SlashProposalService } from './services/slash-proposal.service';

/**
 * The slash domain — proposals, arbitration, execution.
 *
 * `ChainsModule` supplies `SLASH_EXECUTOR`; it is imported directly rather
 * than inherited through another module, on the same reasoning
 * `ProviderSchedulerModule` gives — a module imports what it uses rather than
 * relying on a chain-boundary re-export.
 *
 * `OperatorModule` supplies `OverrideLogService`, and that direction is the
 * load-bearing one: the slash domain depends on the register, never the other
 * way round. If the register ever needed something from here, the fix would be
 * a port rather than an import, because a cycle between "the thing that takes
 * money" and "the record that it was authorised" would be resolvable by
 * removing whichever edge was cheaper — and the cheaper one is always the
 * record.
 */
@Module({
  // `ProviderModule` for `ProviderStakeService` and `ToolModule` for the tool
  // catalogue: the case screen's "What happens if you do nothing" panel states the
  // provider's stake before and after, and its arithmetic table names the tool.
  // Both are reads of somebody else's domain, so they come through that
  // domain's module rather than through a second query written here — a case
  // brief that computed stake its own way would eventually quote a different
  // number than the capital screen, in a dispute.
  imports: [
    NotificationModule,
    // `SlashCompensationService` writes SLASH_DISTRIBUTION through
    // `LedgerService`. Imported rather than re-provided: the ledger owns a
    // write path with its own locking and a snapshot to keep in step, and a
    // second instance of that is not the harmless duplication
    // `ProviderStakeService` is below.
    LedgerModule,
    ChainsModule,
    OperatorModule,
    ProviderModule,
    ToolModule,
    // `MCP_SESSION_SOURCE`, for `SessionAuthGuard` on the provider-facing
    // controller. Every other module with a `SessionAuthGuard` route imports
    // this for the same reason: the guard resolves the tenant, so the module
    // that mounts the route owns the dependency.
    McpModule,
  ],
  controllers: [ProviderSlashProposalsController, ProviderSlashRequestsController],
  providers: [
    { provide: SLASH_CONFIG, useFactory: loadSlashConfig },
    { provide: SLASH_PRORATA_CONFIG, useFactory: loadProRataSlashConfig },
    // `ProviderStakeService` is provided here rather than imported, because it
    // lives in `ProviderApiModule` — the provider domain's *HTTP* module — and
    // importing that would pull the whole provider controller surface into the
    // slash domain to read one number.
    //
    // A second instance is safe and the reason is worth stating: the service is
    // stateless. Everything with a cache behind it — the freshness window on
    // `PROVIDER_STAKE_SOURCE`, the staleness budget on `ONCHAIN_STAKE_READER` —
    // is a provider of `ProviderModule` / `ChainsModule` and is shared, so both
    // instances read the same cached figures and cannot disagree. What this
    // does duplicate is the minimum-stake parameter load, which is env-derived
    // and identical.
    //
    // The right long-term home is `ProviderModule`, so there is one instance
    // and no argument about it. Moving it there means giving that module
    // `ToolModule` and `ChainsModule` edges it does not have today, which is a
    // provider-domain change of its own.
    {
      provide: PROVIDER_MINIMUM_STAKE_PARAMETERS,
      useFactory: loadMinimumStakeParameters,
      inject: [ConfigService],
    },
    ProviderStakeService,
    SlashProposalService,
    SlashCaseService,
    SlashRequestLookupService,
    ArbitrationService,
    // Writes SLASH_DISTRIBUTION and raises the agent-side notification.
    SlashCompensationService,
    SlashPartsService,
    SlashExecutionService,
    // B18: the operator's manual actions on a case stuck behind a cancel.
    SlashStuckCaseService,
    // The dispute upgrade's unsigned provider and arbiter intents (D-19).
    SlashDisputeIntentService,
  ],
  exports: [
    SlashProposalService,
    SlashCaseService,
    ArbitrationService,
    SlashExecutionService,
    SlashStuckCaseService,
    SlashDisputeIntentService,
  ],
})
export class SlashModule {}
