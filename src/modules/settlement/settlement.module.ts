import { Module } from '@nestjs/common';

import { ChainsModule } from '@modules/chains/chains.module';
import { LedgerModule } from '@modules/ledger/ledger.module';

import { DEFAULT_RELAYED_INTENT_RATE_LIMITS } from './domain/relayed-intent-rate-limit';
import { EscrowAccountService } from './services/escrow-account.service';
import {
  RELAYED_INTENT_RATE_LIMITS,
  RelayedIntentRateLimiter,
} from './services/relayed-intent-rate-limiter.service';
import { ReconciliationService } from './services/reconciliation.service';
import { TreasuryVaultService } from './services/treasury-vault.service';
import { WithdrawalService } from './services/withdrawal.service';

/**
 * Settlement domain — the economic consequence, on chain.
 *
 * Scope: the treasury vault and proof of reserves; the 5-minute reconciler; the
 * buyer's escrow — its state, its own brake, and the two-step exit — replacing
 * the earlier off-chain withdrawal authorization entirely; the Anchor program
 * surface (stake, settle, slash) and its parameters; verifier attestations;
 * slash execution and penalty split; shadow mode. Verifier decides, settlement
 * executes — there is no path here that slashes without an attestation.
 *
 * `TreasuryVaultService` knows where the legacy pooled vault is (until the
 * cutover empties it) and sweeps accrued fees; `ReconciliationService` proves
 * every five minutes that both the vault and every buyer's escrow are still
 * what the books say; `EscrowAccountService` reads one buyer's escrow whole;
 * `WithdrawalService` is now the domain service behind every buyer-signed
 * escrow intent — `set_escrow_limits`, `request_withdraw`, `withdraw`,
 * `close_escrow` — none of which this backend can sign, and the first of
 * which (`request_withdraw`/`withdraw`) still refuses when the reconciler's
 * last word was that the vault is short. Everything else in the scope list
 * above is still an empty catalog waiting for the settlement-program services.
 *
 * `ChainsModule` supplies `VAULT_PORT`, `ESCROW_BALANCE_READER`,
 * `EARNINGS_VAULT_READER`, `ESCROW_INTENT_BUILDER` and `ChainAdapterRegistry`
 * (signature verification is a chain concern and never happens in this
 * module). `LedgerModule`
 * supplies nothing this module's own services import directly any more —
 * imported for whichever future settlement-program service needs the debit path. The
 * repositories need no import: `PostgresModule` is `@Global()`, as is
 * `AlertingModule`. Redis is no longer needed here — the withdrawal nonce
 * store it backed is deleted: `BuyerEscrow.withdraw_requested` is a
 * single on-chain slot, so a replay overwrites rather than duplicates.
 */
@Module({
  imports: [ChainsModule, LedgerModule],
  providers: [
    TreasuryVaultService,
    ReconciliationService,
    EscrowAccountService,
    WithdrawalService,
    /**
     * How much of the relayer's gas one buyer may spend in an hour.
     *
     * A `useValue` of the shipped defaults rather than an env read, because
     * there is nothing here an operator has to choose before the first
     * deployment and an unset variable would have to mean *something*. The
     * token exists so a deployment that needs to tighten it can, and so a test
     * can reach a ceiling without making sixty HTTP calls.
     */
    { provide: RELAYED_INTENT_RATE_LIMITS, useValue: DEFAULT_RELAYED_INTENT_RATE_LIMITS },
    RelayedIntentRateLimiter,
  ],
  exports: [TreasuryVaultService, ReconciliationService, EscrowAccountService, WithdrawalService],
})
export class SettlementModule {}
