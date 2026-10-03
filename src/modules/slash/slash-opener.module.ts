import { Module } from '@nestjs/common';

import { NotificationModule } from '@modules/notification/notification.module';

import { SLASH_CONFIG, loadSlashConfig } from './constants/slash.constants';
import { SLASH_PROPOSAL_OPENER } from './ports/slash-proposal-opener.port';
import { SlashDeliveryObserver } from './services/slash-delivery-observer.service';
import { SlashProposalService } from './services/slash-proposal.service';

/**
 * `SlashProposalService`, on its own — the satellite `SlaWindowModule` imports.
 *
 * The same shape and the same reason as `SlaWindowModule` itself. That module
 * exists so `VerificationModule` can reach the SLA window without importing
 * `ProviderModule`; this one exists so `SlaWindowModule` can reach the proposal
 * lifecycle without importing `SlashModule`, which pulls in the operator
 * identity, the override log and the chain executor.
 *
 * Nothing here imports `ProviderModule`, `VerificationModule` or
 * `OperatorModule`, so `SlaWindowModule → SlashOpenerModule` closes no cycle.
 * The repositories come from `PostgresModule`, which is `@Global()`.
 *
 * `SlashModule` re-provides `SlashProposalService` rather than importing this,
 * because the two graphs are disjoint and sharing the instance would drag this
 * module's `NotificationModule` edge into the API process for no benefit — the
 * same argument `SlaWindowModule` makes about not re-exporting
 * `NotificationModule`.
 */
@Module({
  imports: [NotificationModule],
  providers: [
    { provide: SLASH_CONFIG, useFactory: loadSlashConfig },
    SlashProposalService,
    { provide: SLASH_PROPOSAL_OPENER, useExisting: SlashProposalService },
    // Exported unbound: only the worker binds it to `DELIVERY_OBSERVER`, so the
    // api and mcp processes carry the class and never the port.
    SlashDeliveryObserver,
  ],
  exports: [SlashProposalService, SLASH_PROPOSAL_OPENER, SLASH_CONFIG, SlashDeliveryObserver],
})
export class SlashOpenerModule {}
