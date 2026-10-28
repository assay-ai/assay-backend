import { Module } from '@nestjs/common';

import { ChainsModule } from '@modules/chains/chains.module';
import { LedgerModule } from '@modules/ledger/ledger.module';

import { ReconciliationJob } from './jobs/reconciliation.job';
import { ClaimedWithdrawalBooker } from './services/claimed-withdrawal-booker.service';
import { SettlementModule } from './settlement.module';

/**
 * Scheduler-only half of the settlement domain.
 *
 * Same shape and same reason as `PaymentSchedulerModule`: only
 * `AppSchedulerModule` imports this, and the scheduler runs as a single
 * instance, so the 5-minute reconciler fires once per deployment. Importing it
 * into the API would run one reconciliation per API replica — five times the
 * chain reads, five rows per pass in the history table, and five pages for one
 * breach.
 */
/**
 * `ChainsModule` is imported directly rather than re-exported through
 * `SettlementModule`: the job's own dependency is `ChainAdapterRegistry` (it
 * asks which chains this deployment serves in order to know which assets to
 * reconcile), and a module should import what it uses. Re-exporting
 * `ChainsModule` from `SettlementModule` would hand the chain boundary to
 * every future importer of the settlement domain, which defeats the point of
 * keeping chain SDKs behind one boundary.
 *
 * `LedgerModule` for the same reason: `ClaimedWithdrawalBooker` writes each
 * claim's `WITHDRAWAL` entry, once per deployment, beside the reconciler.
 */
@Module({
  imports: [SettlementModule, ChainsModule, LedgerModule],
  providers: [ReconciliationJob, ClaimedWithdrawalBooker],
})
export class SettlementSchedulerModule {}
