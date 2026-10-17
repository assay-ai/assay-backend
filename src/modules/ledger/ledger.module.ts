import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ChainsModule } from '@modules/chains/chains.module';
import { NotificationModule } from '@modules/notification/notification.module';

import { BalancesService } from './services/balances.service';
import { DepositsService } from './services/deposits.service';
import {
  ESCROW_SPEND_GATE_ENABLED,
  EscrowSpendGateService,
  parseEscrowSpendGateEnabled,
} from './services/escrow-spend-gate.service';
import { HoldsService } from './services/holds.service';
import { LedgerBalanceService } from './services/ledger-balance.service';
import { LedgerHoldService } from './services/ledger-hold.service';
import { LedgerJournalService } from './services/ledger-journal.service';
import { LedgerService } from './services/ledger.service';
import { LedgerWithheldService } from './services/ledger-withheld.service';

/**
 * Ledger domain — the off-chain source of truth for value.
 *
 * Scope: append-only journal, derived balances, holds; `withheld`;
 * reconciliation against on-chain state.
 *
 * The repositories are provided globally by `PostgresModule`, so this module
 * declares only the services. `LedgerService` is the port every other domain
 * talks to; the services behind it are exported as well because the
 * reconciler needs
 * `LedgerBalanceService.verifySnapshots()` directly, and `ledger-api.module.ts`
 * needs `LedgerWithheldService` for the balances endpoint's reconciliation —
 * routing all of those through the facade would widen it for three callers.
 *
 * `HoldsService` and `DepositsService` are the read-only list views
 * behind `GET /holds` and `GET /deposits` — thin query-builder wrappers over
 * `LedgerHoldRepository` / `DepositIntentRepository`, kept out of `LedgerPort`
 * for the same reason `LedgerWithheldService` is: they are reporting, not
 * money movement.
 */
@Module({
  // `NotificationModule` — `LedgerJournalService.applyEntries` emits
  // `balance.low` / `balance.zero` on the crossing edge. Imported, not
  // re-exported: nothing outside this module needs `NOTIFICATION_PORT`
  // through `LedgerModule`.
  // `ChainsModule` — `EscrowSpendGateService` needs `ESCROW_BALANCE_READER`
  // (`ChainAdapterRegistry`'s neighbour, not a member of it: the reader is
  // keyed by account/asset, not by chain adapter). This is a one-way import —
  // `ChainsModule` does not import `LedgerModule` — so there is no cycle.
  imports: [NotificationModule, ChainsModule],
  providers: [
    LedgerJournalService,
    LedgerBalanceService,
    LedgerHoldService,
    LedgerWithheldService,
    LedgerService,
    BalancesService,
    HoldsService,
    DepositsService,
    // Fail-closed parse, off by default. `secureFunds` keeps spending from the
    // ledger alone until a human turns this on (the escrow cutover runbook).
    {
      provide: ESCROW_SPEND_GATE_ENABLED,
      useFactory: (config: ConfigService) =>
        parseEscrowSpendGateEnabled(config.get<string>('ESCROW_SPEND_GATE_ENABLED')),
      inject: [ConfigService],
    },
    EscrowSpendGateService,
  ],
  exports: [
    LedgerService,
    LedgerJournalService,
    LedgerBalanceService,
    LedgerHoldService,
    LedgerWithheldService,
    BalancesService,
    HoldsService,
    DepositsService,
    EscrowSpendGateService,
  ],
})
export class LedgerModule {}
