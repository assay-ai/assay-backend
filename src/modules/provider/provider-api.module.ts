import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BlocklistModule } from '@modules/blocklist/blocklist.module';
import { ChainsModule } from '@modules/chains/chains.module';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { ChainId } from '@modules/chains/ports/caip.types';
import { McpModule } from '@modules/mcp/mcp.module';
import { ToolModule } from '@modules/tool/tool.module';
import { VerificationModule } from '@modules/verification/verification.module';
import { AuditLogModule } from '@shared/audit';

import { ProviderConnectivityController } from './controllers/provider-connectivity.controller';
import { ProviderPayoutAddressController } from './controllers/provider-payout-address.controller';
import { ProviderPayoutsController } from './controllers/provider-payouts.controller';
import { ProviderPolicyChangesController } from './controllers/provider-policy-changes.controller';
import { ProviderReconciliationController } from './controllers/provider-reconciliation.controller';
import { ProviderRegistrationController } from './controllers/provider-registration.controller';
import {
  ProviderBindingSlaController,
  ProviderSlaWindowsController,
} from './controllers/provider-sla-windows.controller';
import { ProviderStakeAuthorityController } from './controllers/provider-stake-authority.controller';
import { ProviderStakeIntentController } from './controllers/provider-stake-intent.controller';
import { ProviderToolBindingsController } from './controllers/provider-tool-bindings.controller';
import { ProviderVerdictsController } from './controllers/provider-verdicts.controller';
import { ProviderController } from './controllers/provider.controller';
import { ProviderModule } from './provider.module';
import { SlaWindowModule } from './sla-window.module';
import { ProviderCallsExportService } from './services/provider-calls-export.service';
import { ProviderConnectivityService } from './services/provider-connectivity.service';
import { ProviderEarningsService } from './services/provider-earnings.service';
import { ProviderEgressLimiter } from './services/provider-egress-limiter.service';
import { ProviderPayoutAddressService } from './services/provider-payout-address.service';
import { ProviderPayoutsService } from './services/provider-payouts.service';
import { ProviderPolicyChangesService } from './services/provider-policy-changes.service';
import { ProviderReconciliationService } from './services/provider-reconciliation.service';
import { ProviderProfileService } from './services/provider-profile.service';
import { ProviderRegistrationService } from './services/provider-registration.service';
import { ProviderStakeAuthorityService } from './services/provider-stake-authority.service';
import { ProviderStakeIntentService } from './services/provider-stake-intent.service';
import { ProviderVerificationService } from './services/provider-verification.service';
import { PROVIDER_TERMS, loadProviderTerms } from './services/provider-terms';
import { ProviderQualityService } from './services/provider-quality.service';
import {
  PROVIDER_MINIMUM_STAKE_BY_CHAIN,
  PROVIDER_MINIMUM_STAKE_PARAMETERS,
  ProviderStakeService,
  loadMinimumStakeByChain,
  loadMinimumStakeParameters,
} from './services/provider-stake.service';
import { ProviderSlaWindowsService } from './services/provider-sla-windows.service';
import { BindingEditorService } from './services/binding-editor.service';
import { BindingMappingTesterService } from './services/binding-mapping-tester.service';
import { BindingPauseService } from './services/binding-pause.service';
import { BindingPublishService } from './services/binding-publish.service';
import { ProviderToolBindingsService } from './services/provider-tool-bindings.service';
import { ProviderTrafficService } from './services/provider-traffic.service';
import { ProviderVerdictService } from './services/provider-verdict.service';

/**
 * API-side provider module — imported only by `AppApiModule`.
 *
 * Imports `McpModule` for `MCP_SESSION_SOURCE` (what `SessionAuthGuard`
 * resolves bearer tokens through — same reason `LedgerApiModule` imports it)
 * and `ToolModule` for `TOOL_CATALOGUE`, the port `tool-bindings` and `stake`
 * read the binding list through. `ProviderModule` supplies
 * `PROVIDER_REGISTRY` / `PROVIDER_STAKE_SOURCE`.
 *
 * `PostgresModule` is `@Global` and is not imported here — `PaymentIntent`/
 * `VerificationRecord`/`LedgerEntry` repositories are already available
 * platform-wide once `AppApiModule` brings it in, exactly like
 * `BalancesController`'s dependencies. The same is true of `EgressHttpClient`:
 * `NetworkModule` is `@Global`, which is deliberate — a module that cannot
 * inject it is a module that will reach for `axios`, and the connectivity
 * check is exactly the kind of call site that would.
 *
 * `VerificationModule` is here for the mapping tester, which runs the real
 * deterministic verification pipeline over the mapped response, on the policy this tool's live
 * traffic is judged by, which it resolves through `DecisionPolicyService`. A
 * tester that judged by a private copy of the rules would go green on calls
 * production fails.
 *
 * `ChainsModule` is here because `ProviderPayoutAddressService` verifies a
 * payout-address signature through `ChainAdapterRegistry`, because the ed25519
 * verification and the bytes that were signed both live behind the `chains/`
 * boundary and may not leak out of it.
 * `ProviderStakeAuthorityService` is the second call site, on the same terms —
 * including the version tag it compares `message_version` against, which it
 * asks the adapter for rather than importing.
 *
 * ## The registration controllers
 *
 * Three controllers, in the order a provider meets them: register
 * (`ProviderRegistrationController`), prove the payout wallet
 * (`ProviderPayoutAddressController`), then declare and probe the endpoint
 * (`ProviderConnectivityController`, which also serves the `verified`
 * label to the catalogue). None of the three consults an approval anywhere —
 * see `provider.entity.ts` for why that absence is the point.
 *
 * `SlaWindowModule` is imported for `SLA_WINDOW_CONFIG` —
 * `ProviderSlaWindowsService`'s read side needs the same frozen constants
 * (`minVerifiedCalls`, `zScore`) the write side opens a window under, so the
 * workbench's "effective threshold at your own volume" is computed against
 * the live constant rather than a second copy of it. `SlaWindowService`
 * itself is unused here — the write path runs only through
 * `VerificationSettlementService`'s `SLA_WINDOW_POSTER`.
 */
@Module({
  imports: [
    AuditLogModule,
    ProviderModule,
    BlocklistModule,
    ToolModule,
    McpModule,
    ChainsModule,
    VerificationModule,
    SlaWindowModule,
  ],
  controllers: [
    ProviderRegistrationController,
    ProviderPayoutAddressController,
    ProviderConnectivityController,
    ProviderController,
    ProviderPayoutsController,
    ProviderToolBindingsController,
    ProviderVerdictsController,
    ProviderReconciliationController,
    ProviderPolicyChangesController,
    ProviderSlaWindowsController,
    ProviderBindingSlaController,
    ProviderStakeAuthorityController,
    ProviderStakeIntentController,
  ],
  providers: [
    { provide: PROVIDER_TERMS, useFactory: loadProviderTerms, inject: [ConfigService] },
    ProviderRegistrationService,
    ProviderPayoutAddressService,
    ProviderStakeAuthorityService,
    ProviderStakeIntentService,
    ProviderConnectivityService,
    ProviderEgressLimiter,
    ProviderVerificationService,
    ProviderProfileService,
    ProviderTrafficService,
    ProviderQualityService,
    ProviderEarningsService,
    ProviderCallsExportService,
    ProviderPayoutsService,
    ProviderVerdictService,
    ProviderReconciliationService,
    ProviderPolicyChangesService,
    ProviderToolBindingsService,
    BindingEditorService,
    BindingMappingTesterService,
    BindingPublishService,
    BindingPauseService,
    ProviderSlaWindowsService,
    {
      provide: PROVIDER_MINIMUM_STAKE_PARAMETERS,
      useFactory: loadMinimumStakeParameters,
      inject: [ConfigService],
    },
    {
      // The same floor the router gates on, keyed by chain — one derivation
      // shared with `ToolModule.ROUTER_CONFIG`, so the binding editor's
      // write-time refusal and the routing refusal cannot be
      // about different numbers.
      provide: PROVIDER_MINIMUM_STAKE_BY_CHAIN,
      useFactory: (config: ConfigService, enabled: readonly ChainId[]) =>
        loadMinimumStakeByChain(config, enabled),
      inject: [ConfigService, ENABLED_CHAINS],
    },
    ProviderStakeService,
  ],
  exports: [ProviderModule],
})
export class ProviderApiModule {}
